import { normalizeJobConfig } from '../config/smartDefaults';
import type { ChunkMeta, ChunkText, Job, JobConfig, JobEvent, JobProgress, RateLimitEvent, ResultRecord, TrafficSample } from '../types';
import { newId, shortId } from '../util/ids';
import { idb, kv, openDb } from './db';

const chunkId = (jobId: string, index: number): string => `${jobId}:${index}`;
/** 覆盖大任务一小时内数百个会话，避免输出预算统计因旧样本被截掉而失真。 */
const TRAFFIC_HISTORY_LIMIT = 1_024;
export const JOB_EVENT_LOG_LIMIT = 2_000;

const normalizeJob = (job: Job): Job => ({
  ...job,
  config: normalizeJobConfig(job.config),
  providerSessionRefs: Array.isArray(job.providerSessionRefs) ? job.providerSessionRefs : [],
  trafficHistory: Array.isArray(job.trafficHistory) ? job.trafficHistory : [],
  rateLimitEvents: (() => {
    if (!Array.isArray(job.rateLimitEvents)) return [];
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    return job.rateLimitEvents.map((event): RateLimitEvent => {
      // 旧任务只有 inputChars/outputChars；补齐新字段后工作台和策略可明确区分
      // “本轮新增”与“累计”，且不改变旧记录的原始数值。
      const intervalInput = Number.isFinite(event.intervalInputChars)
        ? event.intervalInputChars!
        : Math.max(0, event.inputChars ?? 0);
      const intervalOutput = Number.isFinite(event.intervalOutputChars)
        ? event.intervalOutputChars!
        : Math.max(0, event.outputChars ?? 0);
      cumulativeInput = Number.isFinite(event.cumulativeInputChars)
        ? event.cumulativeInputChars!
        : cumulativeInput + intervalInput;
      cumulativeOutput = Number.isFinite(event.cumulativeOutputChars)
        ? event.cumulativeOutputChars!
        : cumulativeOutput + intervalOutput;
      return {
        ...event,
        intervalInputChars: intervalInput,
        intervalOutputChars: intervalOutput,
        cumulativeInputChars: cumulativeInput,
        cumulativeOutputChars: cumulativeOutput,
      };
    });
  })(),
  eventLog: Array.isArray(job.eventLog) ? job.eventLog.slice(-JOB_EVENT_LOG_LIMIT) : [],
});

export function appendJobEvent(job: Job, kind: string, detail: string): Job {
  const event: JobEvent = { at: Date.now(), kind, detail: detail.slice(0, 500) };
  return { ...job, eventLog: [...(job.eventLog ?? []), event].slice(-JOB_EVENT_LOG_LIMIT) };
}

const withOutputTraffic = (job: Job, marker: string, outputChars: number): Job => {
  const history = Array.isArray(job.trafficHistory) ? job.trafficHistory : [];
  const completedAt = Date.now();
  let changed = false;
  const next = history.map((sample) => {
    if (sample.marker !== marker || sample.outputChars != null) return sample;
    changed = true;
    return { ...sample, outputChars, completedAt };
  });
  return changed ? { ...job, trafficHistory: next } : job;
};

export async function createJob(name: string, config: JobConfig, providerId: string, totalChunks = 0): Promise<Job> {
  const id = newId();
  const now = Date.now();
  const job: Job = {
    id,
    shortId: shortId(id),
    name,
    createdAt: now,
    updatedAt: now,
    status: 'split',
    prevStatus: null,
    config: normalizeJobConfig(config),
    providerId,
    providerConnectionId: null,
    providerSessionRefs: [],
    sessionCooldownUntil: undefined,
    sessionCooldownStartedAt: undefined,
    sessionCooldownReason: undefined,
    trafficHistory: [],
    rateLimitEvents: [],
    eventLog: [],
    current: null,
    reduceState: null,
    formatState: null,
    formatPlanResultId: null,
    totalChunks,
    failedChunks: [],
    finalResultId: null,
    lastError: null,
    stats: { sent: 0, collected: 0, rateLimitHits: 0 },
  };
  await idb.put('jobs', job);
  return job;
}

export async function getJob(jobId: string): Promise<Job | undefined> {
  const job = await idb.get<Job>('jobs', jobId);
  return job ? normalizeJob(job) : undefined;
}

export const saveJob = (job: Job): Promise<IDBValidKey> => idb.put('jobs', { ...job, updatedAt: Date.now() });

export const listJobs = async (): Promise<Job[]> =>
  (await idb.getAll<Job>('jobs'))
    .map(normalizeJob)
    .sort((a, b) => b.createdAt - a.createdAt);

export async function deleteJob(jobId: string): Promise<void> {
  const metas = await idb.byIndex<ChunkMeta>('chunks', 'byJob', jobId);
  const results = await idb.byIndex<ResultRecord>('results', 'byJob', jobId);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['jobs', 'chunks', 'chunkTexts', 'results'], 'readwrite');
    t.objectStore('jobs').delete(jobId);
    const chunks = t.objectStore('chunks');
    const texts = t.objectStore('chunkTexts');
    for (const m of metas) {
      chunks.delete(m.id);
      texts.delete(m.id);
    }
    const rs = t.objectStore('results');
    for (const r of results) rs.delete(r.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  if ((await kv.get<string>('activeJobId')) === jobId) await kv.del('activeJobId');
}

/** 建任务时一次性写入全部 Chunk（元数据 + 正文），单事务保证不半残 */
export async function addChunks(jobId: string, texts: string[]): Promise<void> {
  return appendChunks(jobId, 0, texts);
}

/** 以批次追加 Chunk，便于流式导入且每一批都是完整事务。 */
export async function appendChunks(jobId: string, startIndex: number, texts: string[]): Promise<void> {
  if (texts.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['jobs', 'chunks', 'chunkTexts'], 'readwrite');
    const jobStore = t.objectStore('jobs');
    const metas = t.objectStore('chunks');
    const bodies = t.objectStore('chunkTexts');
    texts.forEach((text, offset) => {
      const index = startIndex + offset;
      const id = chunkId(jobId, index);
      const meta: ChunkMeta = {
        id,
        jobId,
        index,
        status: 'pending',
        attempts: 0,
        stage: 'index',
        indexResultId: null,
        resultId: null,
        error: null,
      };
      const body: ChunkText = { id, text };
      metas.put(meta);
      bodies.put(body);
    });
    const req = jobStore.get(jobId);
    req.onsuccess = () => {
      const job = req.result as Job | undefined;
      if (job) jobStore.put({ ...job, totalChunks: Math.max(job.totalChunks, startIndex + texts.length), updatedAt: Date.now() });
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** 在已持久化的 current 上记录 Provider 已观察到提交确认。 */
export async function markUnitSubmitted(
  jobId: string,
  marker: string,
  connectionId: string,
  remoteRef: string | null | undefined,
  kind: 'index' | 'extract' | 'format' | 'normalize' | 'reduce',
  index?: number,
): Promise<Job | undefined> {
  const db = await openDb();
  return new Promise<Job | undefined>((resolve, reject) => {
    const t = db.transaction(['jobs', 'chunks'], 'readwrite');
    const jobs = t.objectStore('jobs');
    const chunks = t.objectStore('chunks');
    let result: Job | undefined;
    const req = jobs.get(jobId);
    req.onsuccess = () => {
      const job = req.result as Job | undefined;
      if (!job || !job.current || job.current.marker !== marker) return;
      const already = job.current.phase === 'acknowledged';
      const knownSessionRefs = Array.isArray(job.providerSessionRefs) ? job.providerSessionRefs : [];
      const sessionRefs = remoteRef && !knownSessionRefs.includes(remoteRef)
        ? [...knownSessionRefs, remoteRef]
        : knownSessionRefs;
      const now = Date.now();
      const trafficHistory = already
        ? (Array.isArray(job.trafficHistory) ? job.trafficHistory : [])
        : [...(Array.isArray(job.trafficHistory) ? job.trafficHistory : []), {
          marker,
          submittedAt: now,
          inputChars: Math.max(0, job.current.inputChars ?? 0),
        } satisfies TrafficSample].slice(-TRAFFIC_HISTORY_LIMIT);
      const next: Job = appendJobEvent({
        ...job,
        providerConnectionId: connectionId,
        providerSessionRefs: sessionRefs,
        current: { ...job.current, phase: 'acknowledged', remoteRef: remoteRef ?? job.current.remoteRef ?? null },
        trafficHistory,
        stats: already ? job.stats : { ...job.stats, sent: job.stats.sent + 1 },
        updatedAt: now,
      }, 'submitted', `${kind}/${job.current.ref} 已确认提交（第 ${job.current.attempt} 次）`);
      jobs.put(next);
      if ((kind === 'index' || kind === 'extract') && index != null) {
        const metaReq = chunks.get(chunkId(jobId, index));
        metaReq.onsuccess = () => {
          const meta = metaReq.result as ChunkMeta | undefined;
          if (meta && meta.status !== 'done') chunks.put({ ...meta, status: 'sent', attempts: job.current?.attempt ?? meta.attempts });
        };
      }
      result = next;
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** 索引结果、分块阶段与 Job 推进一次提交；完成后该分块回到 pending 等待目标处理。 */
export async function commitIndexed(
  jobId: string,
  marker: string,
  result: ResultRecord,
  chunkIndex: number,
): Promise<Job | undefined> {
  const db = await openDb();
  return new Promise<Job | undefined>((resolve, reject) => {
    const t = db.transaction(['jobs', 'chunks', 'results'], 'readwrite');
    const jobs = t.objectStore('jobs');
    const chunks = t.objectStore('chunks');
    const results = t.objectStore('results');
    let output: Job | undefined;
    const req = jobs.get(jobId);
    req.onsuccess = () => {
      const job = req.result as Job | undefined;
      if (!job?.current || job.current.marker !== marker) return;
      const resultReq = results.get(result.id);
      resultReq.onsuccess = () => {
        // 结果记录可能已在上一次事务中写入，但 Job 指针因扩展重载尚未推进。
        // 不能直接返回，否则页面已有完整回复而任务会永久卡在 current。
        // 同一结果 ID 代表同一 attempt，保留已写入正文并继续完成指针推进。
        const committedResult = resultReq.result as ResultRecord | undefined;
        if (!committedResult) results.put(result);
        const trafficMarker = job.current!.marker;
        const trafficUnit = job.current!;
        // 限流期间如果当前远端会话确实产出了完整回复，说明用户手动续写已让
        // 当前会话恢复。清除任务级冷却，避免收集完成后 pump 仍被旧冷却拦截。
        const recoveredFromRateLimit = trafficUnit.rateLimited === true;
        const metaReq = chunks.get(chunkId(jobId, chunkIndex));
        metaReq.onsuccess = () => {
          const meta = metaReq.result as ChunkMeta | undefined;
          if (meta) chunks.put({
            ...meta,
            status: 'pending',
            attempts: 0,
            stage: 'process',
            indexResultId: result.id,
            error: null,
          });
        };
        output = withOutputTraffic(appendJobEvent({
          ...job,
          current: null,
          sessionCooldownUntil: recoveredFromRateLimit ? undefined : job.sessionCooldownUntil,
          sessionCooldownStartedAt: recoveredFromRateLimit ? undefined : job.sessionCooldownStartedAt,
          sessionCooldownReason: recoveredFromRateLimit ? undefined : job.sessionCooldownReason,
          status: job.status === 'paused' ? 'paused' : 'processing',
          prevStatus: job.status === 'paused' ? 'processing' : job.prevStatus,
          lastError: null,
          stats: { ...job.stats, collected: job.stats.collected + 1 },
          updatedAt: Date.now(),
        }, 'collected', `${trafficUnit.kind}/${trafficUnit.ref} 已收集回复${recoveredFromRateLimit ? '；限流期间当前会话已恢复，继续任务调度' : ''}`), trafficMarker,
        (committedResult ?? result).raw.length);
        jobs.put(output);
      };
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve(output);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** 结果、Chunk 状态与 Job 推进必须一次提交，重复收到同一 marker 不增加统计。 */
export async function commitCollected(
  jobId: string,
  marker: string,
  result: ResultRecord,
  nextStatus: 'processing' | 'reducing',
  chunkIndex?: number,
  reduceState?: Job['reduceState'],
  formatState?: Job['formatState'],
  formatPlanResultId?: string | null,
): Promise<Job | undefined> {
  const db = await openDb();
  return new Promise<Job | undefined>((resolve, reject) => {
    const stores = ['jobs', 'chunks', 'results'] as const;
    const t = db.transaction([...stores], 'readwrite');
    const jobs = t.objectStore('jobs');
    const chunks = t.objectStore('chunks');
    const results = t.objectStore('results');
    let output: Job | undefined;
    const req = jobs.get(jobId);
    req.onsuccess = () => {
      const job = req.result as Job | undefined;
      if (!job || !job.current || job.current.marker !== marker) return;
      // 同一 marker 已在事务中提交过时，直接返回当前状态。
      const resultReq = results.get(result.id);
      resultReq.onsuccess = () => {
        const existing = resultReq.result as ResultRecord | undefined;
        // 结果可能已经写入，但任务指针尚未推进（例如扩展重载发生在两步之间）。
        // 继续执行收集提交，避免任务永久停在 current。
        if (!existing) results.put(result);
        const trafficMarker = job.current!.marker;
        const trafficUnit = job.current!;
        // 同上：人工继续生成并成功收集结果是限流恢复的可靠证据。
        const recoveredFromRateLimit = trafficUnit.rateLimited === true;
        if (chunkIndex != null) {
          const metaReq = chunks.get(chunkId(jobId, chunkIndex));
          metaReq.onsuccess = () => {
            const meta = metaReq.result as ChunkMeta | undefined;
            if (meta) chunks.put({ ...meta, status: 'done', stage: 'done', resultId: result.id, error: null });
          };
        }
        output = withOutputTraffic(appendJobEvent({
          ...job,
          current: null,
          sessionCooldownUntil: recoveredFromRateLimit ? undefined : job.sessionCooldownUntil,
          sessionCooldownStartedAt: recoveredFromRateLimit ? undefined : job.sessionCooldownStartedAt,
          sessionCooldownReason: recoveredFromRateLimit ? undefined : job.sessionCooldownReason,
          status: job.status === 'paused' ? 'paused' : nextStatus,
          prevStatus: job.status === 'paused' ? nextStatus : job.prevStatus,
          reduceState: reduceState === undefined ? job.reduceState : reduceState,
          formatState: formatState === undefined ? job.formatState : formatState,
          formatPlanResultId: formatPlanResultId === undefined ? job.formatPlanResultId : formatPlanResultId,
          lastError: null,
          stats: { ...job.stats, collected: job.stats.collected + 1 },
          updatedAt: Date.now(),
        }, 'collected', `${trafficUnit.kind}/${trafficUnit.ref} 已收集回复${recoveredFromRateLimit ? '；限流期间当前会话已恢复，继续任务调度' : ''}`), trafficMarker,
        (existing ?? result).raw.length);
        if (job.status !== 'paused' && nextStatus === 'reducing' && reduceState) output.reduceState = reduceState;
        jobs.put(output);
      };
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve(output);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** 失败也要原子清除 current 与 Chunk 在途状态，避免重启后卡死。 */
export async function commitUnitFailure(jobId: string, marker: string, reason: string, index?: number): Promise<Job | undefined> {
  const db = await openDb();
  return new Promise<Job | undefined>((resolve, reject) => {
    const t = db.transaction(['jobs', 'chunks'], 'readwrite');
    const jobs = t.objectStore('jobs');
    const chunks = t.objectStore('chunks');
    let output: Job | undefined;
    const req = jobs.get(jobId);
    req.onsuccess = () => {
      const job = req.result as Job | undefined;
      if (!job || !job.current || job.current.marker !== marker) return;
      if (index != null) {
        const mr = chunks.get(chunkId(jobId, index));
        mr.onsuccess = () => {
          const meta = mr.result as ChunkMeta | undefined;
          if (meta) chunks.put({ ...meta, status: 'failed', error: reason });
        };
      }
      output = {
        ...job,
        current: null,
        lastError: reason,
        failedChunks: index == null || job.failedChunks.includes(index) ? job.failedChunks : [...job.failedChunks, index],
        updatedAt: Date.now(),
      };
      jobs.put(output);
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => resolve(output);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getChunkMeta = (jobId: string, index: number): Promise<ChunkMeta | undefined> =>
  idb.get<ChunkMeta>('chunks', chunkId(jobId, index));

export const saveChunkMeta = (meta: ChunkMeta): Promise<IDBValidKey> => idb.put('chunks', meta);

/** 重跑只切换当前任务与受影响分块的指针，历史结果和日志全部保留。 */
export async function commitReprocessPlan(job: Job, metas: ChunkMeta[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['jobs', 'chunks'], 'readwrite');
    t.objectStore('jobs').put({ ...job, updatedAt: Date.now() });
    const chunks = t.objectStore('chunks');
    for (const meta of metas) chunks.put(meta);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getChunkTextById = async (id: string): Promise<string | undefined> =>
  (await idb.get<ChunkText>('chunkTexts', id))?.text;

export const chunkMetasByJob = (jobId: string): Promise<ChunkMeta[]> => idb.byIndex<ChunkMeta>('chunks', 'byJob', jobId);

export async function nextPendingChunk(jobId: string): Promise<ChunkMeta | null> {
  const metas = await chunkMetasByJob(jobId);
  let best: ChunkMeta | null = null;
  for (const m of metas) {
    if (m.status === 'pending' && (best === null || m.index < best.index)) best = m;
  }
  return best;
}

export async function jobProgress(jobId: string): Promise<JobProgress> {
  const metas = await chunkMetasByJob(jobId);
  const prog: JobProgress = { total: metas.length, indexed: 0, pending: 0, sent: 0, done: 0, failed: 0 };
  for (const m of metas) {
    if (m.indexResultId) prog.indexed++;
    if (m.status === 'pending') prog.pending++;
    else if (m.status === 'sent') prog.sent++;
    else if (m.status === 'done') prog.done++;
    else prog.failed++;
  }
  return prog;
}

/** 幂等：结果 id 由 jobId+ref+attempt 决定，重复收取同 id 覆盖写，不产生重复结果 */
export const saveResult = (r: ResultRecord): Promise<IDBValidKey> => idb.put('results', r);

export const getResult = (id: string): Promise<ResultRecord | undefined> => idb.get<ResultRecord>('results', id);

export const resultsByJob = (jobId: string): Promise<ResultRecord[]> => idb.byIndex<ResultRecord>('results', 'byJob', jobId);

export const getActiveJobId = (): Promise<string | undefined> => kv.get<string>('activeJobId');

export const setActiveJobId = (jobId: string | null): Promise<IDBValidKey | undefined> =>
  jobId === null ? kv.del('activeJobId') : kv.set('activeJobId', jobId);
