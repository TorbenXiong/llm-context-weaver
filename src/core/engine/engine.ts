/** Provider 无关的持久化编排引擎。 */
import { buildExtractionPrompt, buildReducePrompt, formatMarker } from '../protocol/prompts';
import { sanitizeExtraction } from '../protocol/schema';
import type { ProviderHost, ProviderInspection } from '../provider';
import { planGroups } from '../reduce/reducePlanner';
import {
  chunkMetasByJob,
  commitCollected,
  commitUnitFailure,
  getActiveJobId,
  getChunkMeta,
  getChunkTextById,
  getJob,
  getResult,
  jobProgress,
  markUnitSubmitted,
  nextPendingChunk,
  saveChunkMeta,
  saveJob,
  setActiveJobId,
} from '../storage/jobStore';
import type { ChunkMeta, CurrentUnit, Job, JobStatus, ResultRecord } from '../types';
import { sleep } from '../util/sleep';
import { isActive, isTerminal, transitionJob } from './stateMachine';

export interface EngineHost extends ProviderHost {
  scheduleAlarm(name: string, when: number): void;
  clearAlarm(name: string): void;
  log(...args: unknown[]): void;
}

const TIMEOUT_ALARM = (jobId: string): string => `lcw:t:${jobId}`;
const RESUME_ALARM = (jobId: string): string => `lcw:r:${jobId}`;
const RETRY_DELAY_MS = 5_000;
const REGEN_CHECK_MS = 30_000;
const errMsg = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface UnitRef {
  kind: 'extract' | 'reduce';
  ref: string;
  prevAttempt: number;
}

export class Engine {
  constructor(private readonly host: EngineHost) {}

  async startJob(jobId: string): Promise<void> {
    const activeId = await getActiveJobId();
    if (activeId && activeId !== jobId) {
      const other = await getJob(activeId);
      if (other && isActive(other.status)) throw new Error('已有进行中的任务，请先暂停或取消');
    }
    let job = await this.mustGet(jobId);
    if (job.status === 'split' || job.status === 'failed') {
      await setActiveJobId(jobId);
      job = await this.to(job, job.current ? 'waiting' : job.reduceState ? 'reducing' : 'processing');
    } else if (!isActive(job.status)) {
      throw new Error(`任务当前状态(${job.status})不可启动`);
    } else {
      await setActiveJobId(jobId);
    }
    if (job.current) await this.reconcile(job, 'start');
    else await this.pump(job.id);
  }

  async pump(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job || !isActive(job.status)) return;
    if (job.current) return this.reconcile(job, 'pump');
    if (job.status === 'waiting') job = await this.to(job, job.reduceState ? 'reducing' : 'processing');
    if (job.status === 'processing') return this.dispatchNextExtract(job);
    if (job.status === 'reducing') return this.dispatchNextReduce(job);
  }

  async pause(jobId: string): Promise<void> {
    const job = await getJob(jobId);
    if (!job || !isActive(job.status)) return;
    await this.to(job, 'paused');
    this.host.clearAlarm(TIMEOUT_ALARM(jobId));
    this.host.clearAlarm(RESUME_ALARM(jobId));
  }

  async resume(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job || job.status !== 'paused') return;
    job = await this.to(job, job.prevStatus ?? (job.reduceState ? 'reducing' : 'processing'));
    if (job.current) await this.reconcile(job, 'resume');
    else await this.pump(job.id);
  }

  async cancel(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job || isTerminal(job.status)) return;
    job = { ...job, current: null };
    await saveJob(job);
    await this.to(job, 'canceled');
    this.host.clearAlarm(TIMEOUT_ALARM(jobId));
    this.host.clearAlarm(RESUME_ALARM(jobId));
    if ((await getActiveJobId()) === jobId) await setActiveJobId(null);
  }

  async retryChunk(jobId: string, index: number): Promise<void> {
    let job = await getJob(jobId);
    const meta = await getChunkMeta(jobId, index);
    if (!job || !meta || meta.status !== 'failed' || job.current) return;
    await saveChunkMeta({ ...meta, status: 'pending', attempts: 0, resultId: null, error: null });
    job = { ...job, failedChunks: job.failedChunks.filter((value) => value !== index), reduceState: null,
      finalResultId: null, lastError: null };
    await saveJob(job);
    if (job.status === 'failed' || job.status === 'completed') job = await this.to(job, 'processing');
    if (isActive(job.status)) await this.pump(job.id);
  }

  async retryFailed(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job) return;
    // 模糊投递保留 current；恢复动作首先对账，绝不直接重发。
    if (job.current) {
      if (job.status === 'failed') job = await this.to(job, 'waiting');
      await setActiveJobId(job.id);
      return this.reconcile(job, 'manual recovery');
    }
    for (const index of job.failedChunks) {
      const meta = await getChunkMeta(jobId, index);
      if (meta?.status === 'failed') await saveChunkMeta({ ...meta, status: 'pending', attempts: 0, resultId: null, error: null });
    }
    job = { ...job, failedChunks: [], reduceState: null, finalResultId: null, lastError: null };
    await saveJob(job);
    if (job.status === 'failed' || job.status === 'completed') job = await this.to(job, 'processing');
    await setActiveJobId(job.id);
    if (isActive(job.status)) await this.pump(job.id);
  }

  /** 仅供用户确认远端未收到请求后使用；这是唯一允许主动越过模糊投递保护的入口。 */
  async forceRetryCurrent(jobId: string): Promise<void> {
    let job = await getJob(jobId);
    if (!job?.current || job.status !== 'failed') return;
    job = await this.to(job, 'waiting');
    await setActiveJobId(job.id);
    await this.resend(job, '用户确认远端未收到请求', true);
  }

  async resumeActive(): Promise<void> {
    const activeId = await getActiveJobId();
    if (!activeId) return;
    const job = await getJob(activeId);
    if (job && isActive(job.status)) this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + 2_000);
  }

  async onAlarm(name: string): Promise<void> {
    const match = /^lcw:([tr]):(.+)$/.exec(name);
    if (!match?.[2]) return;
    const job = await getJob(match[2]);
    if (!job || !isActive(job.status)) return;
    if (job.current) await this.reconcile(job, match[1] === 't' ? 'timeout' : 'retry');
    else await this.pump(job.id);
  }

  async onAdapterReady(connectionId: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || (job.providerConnectionId && job.providerConnectionId !== connectionId)) return;
    if (job.current) this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + 1_500);
  }

  async onGenerationStart(_connectionId: string): Promise<void> {}

  async onGenerationEnd(connectionId: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || !job.current || job.providerConnectionId !== connectionId) return;
    if (job.status === 'waiting' || job.status === 'paused') await this.reconcile(job, 'generation end');
  }

  async onRateLimited(connectionId: string, detail: string): Promise<void> {
    let job = await this.activeJob();
    if (!job || !job.current || job.providerConnectionId !== connectionId) return;
    job = { ...job, current: { ...job.current, rateLimited: true },
      stats: { ...job.stats, rateLimitHits: job.stats.rateLimitHits + 1 }, lastError: detail };
    await saveJob(job);
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + RETRY_DELAY_MS);
  }

  async onAdapterError(connectionId: string, detail: string): Promise<void> {
    const job = await this.activeJob();
    if (!job || job.providerConnectionId !== connectionId) return;
    await saveJob({ ...job, lastError: detail });
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + RETRY_DELAY_MS);
  }

  async onRemoteRefChanged(connectionId: string, remoteRef: string): Promise<void> {
    const job = await this.activeJob();
    if (!job?.current || job.providerConnectionId !== connectionId || !remoteRef) return;
    await saveJob({ ...job, current: { ...job.current, remoteRef } });
  }

  async onConnectionGone(jobId: string, connectionId: string): Promise<void> {
    const job = await getJob(jobId);
    if (!job || job.providerConnectionId !== connectionId) return;
    await saveJob({ ...job, providerConnectionId: null });
    if (job.current && isActive(job.status)) this.host.scheduleAlarm(RESUME_ALARM(jobId), Date.now() + 3_000);
  }

  private async mustGet(jobId: string): Promise<Job> {
    const job = await getJob(jobId);
    if (!job) throw new Error('任务不存在');
    return job;
  }

  private async activeJob(): Promise<Job | null> {
    const id = await getActiveJobId();
    return id ? (await getJob(id)) ?? null : null;
  }

  private async to(job: Job, status: JobStatus): Promise<Job> {
    const next = transitionJob(job, status, Date.now());
    await saveJob(next);
    return next;
  }

  private async dispatchNextExtract(job: Job): Promise<void> {
    const meta = await nextPendingChunk(job.id);
    if (!meta) {
      const progress = await jobProgress(job.id);
      if (progress.sent > 0) return;
      if (progress.failed > 0) return this.failJob(job, `有 ${progress.failed} 个分块失败，请重试后再归并`);
      return this.beginReduce(job);
    }
    const text = await getChunkTextById(meta.id);
    if (text == null) return this.failUnit(job, `chunk ${meta.index} 内容缺失`);
    return this.dispatchUnit(job, { kind: 'extract', ref: String(meta.index), prevAttempt: meta.attempts },
      (marker) => buildExtractionPrompt(marker, text), meta);
  }

  private async dispatchNextReduce(job: Job): Promise<void> {
    let state = job.reduceState;
    if (!state) return this.beginReduce(job);
    if (state.nextGroup >= state.groups.length) {
      if (state.outputIds.length === 0) return this.failJob(job, '归并未产出任何结果');
      if (state.outputIds.length === 1) return this.finalize(job, state.outputIds[0]!);
      const results = await this.loadResults(state.outputIds);
      if (results.length !== state.outputIds.length) return this.failJob(job, '归并结果记录缺失');
      const groups = planGroups(results.map((r) => JSON.stringify(r.parsed).length),
        { fanIn: job.config.fanIn, maxChars: job.config.reduceMaxInputChars });
      if (groups.length >= state.outputIds.length) {
        return this.failJob(job, '归并输入超过预算且无法继续收敛；请提高归并预算或缩小提炼结果');
      }
      state = { level: state.level + 1, inputIds: state.outputIds, groups, nextGroup: 0, outputIds: [] };
      job = { ...job, reduceState: state };
      await saveJob(job);
    }
    const groupIndex = state.nextGroup;
    const group = state.groups[groupIndex];
    if (!group) return this.failJob(job, `归并分组缺失: ${groupIndex}`);
    const ids = state.inputIds.slice(group.start, group.end);
    const results = await this.loadResults(ids);
    if (results.length !== ids.length) return this.failJob(job, `归并输入缺失: level ${state.level} group ${groupIndex}`);
    const ref = `${state.level}-${groupIndex}`;
    const matched = job.current?.kind === 'reduce' && job.current.ref === ref ? job.current : null;
    const prevAttempt = Math.max(0, (matched?.attempt ?? 0) - (matched?.rateLimited ? 1 : 0));
    return this.dispatchUnit(job, { kind: 'reduce', ref, prevAttempt },
      (marker) => buildReducePrompt(marker, results.map((r) => JSON.stringify(r.parsed))));
  }

  private async dispatchUnit(job: Job, unit: UnitRef, makePrompt: (marker: string) => string, meta?: ChunkMeta): Promise<void> {
    const attempt = unit.prevAttempt + 1;
    const marker = formatMarker({ jobShort: job.shortId, kind: unit.kind, ref: unit.ref, attempt });
    const current: CurrentUnit = { kind: unit.kind, ref: unit.ref, attempt, marker, phase: 'prepared', remoteRef: null };
    job = { ...job, current };
    await saveJob(job);
    await sleep(job.config.sendDelayMs);
    let fresh = await getJob(job.id);
    if (!fresh || fresh.status === 'paused' || fresh.status === 'canceled' || fresh.current?.marker !== marker) return;
    await this.submitPrepared(fresh, makePrompt(marker), meta);
  }

  private async submitPrepared(job: Job, prompt: string, meta?: ChunkMeta): Promise<void> {
    const current = job.current;
    if (!current || current.phase !== 'prepared') return;
    const marker = current.marker;
    try {
      const connectionId = await this.ensureConnection(job);
      await this.host.prepare(connectionId, current);
      const fresh = await getJob(job.id);
      if (!fresh || fresh.status === 'paused' || fresh.status === 'canceled' || fresh.current?.marker !== marker) return;
      job = { ...fresh, current: { ...current, phase: 'submitting' }, providerConnectionId: connectionId };
      await saveJob(job);
      const outcome = await this.host.submit(connectionId, marker, prompt);
      if (outcome.status === 'accepted') {
        const acknowledged = await markUnitSubmitted(job.id, marker, connectionId, outcome.remoteRef, current.kind, meta?.index);
        if (!acknowledged || acknowledged.status === 'paused' || acknowledged.status === 'canceled') return;
        job = acknowledged.status === 'waiting' ? acknowledged : await this.to(acknowledged, 'waiting');
        this.host.scheduleAlarm(TIMEOUT_ALARM(job.id), Date.now() + job.config.generationTimeoutMs);
      } else if (outcome.status === 'rate_limited') {
        await this.noteRateLimit(job, outcome.detail, outcome.retryAfterMs);
      } else if (outcome.status === 'retryable') {
        await this.scheduleSafeRetry(job, outcome.detail, outcome.retryAfterMs);
      } else if (outcome.status === 'rejected') {
        await this.resend(job, `Provider 明确拒绝提交: ${outcome.detail}`);
      } else {
        await this.failJob(job, `提交结果不明确，已停止自动重发以避免重复发送: ${outcome.detail}`, true);
      }
    } catch (error) {
      await this.failJob(job, `提交过程失联，已停止自动重发以避免重复发送: ${errMsg(error)}`, true);
    }
  }

  private async scheduleSafeRetry(job: Job, detail: string, retryAfterMs: number): Promise<void> {
    if (!job.current) return;
    job = { ...job, current: { ...job.current, phase: 'prepared' }, lastError: detail };
    await saveJob(job);
    if (job.status !== 'waiting' && job.status !== 'paused') job = await this.to(job, 'waiting');
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + Math.max(RETRY_DELAY_MS, retryAfterMs));
  }

  private async ensureConnection(job: Job): Promise<string> {
    if (job.providerConnectionId) return job.providerConnectionId;
    const id = await this.host.connect(job);
    await saveJob({ ...job, providerConnectionId: id });
    return id;
  }

  private async reconcile(job: Job, why: string): Promise<void> {
    if (job.status === 'paused' || !job.current) return;
    if (job.current.phase === 'prepared') return this.resumePrepared(job);
    const unit = job.current;
    try {
      const connectionId = await this.ensureConnection(job);
      if (connectionId !== job.providerConnectionId) {
        job = { ...job, providerConnectionId: connectionId };
        await saveJob(job);
      }
      await this.host.prepare(connectionId, unit);
      await this.handleInspection(job, await this.host.inspect(connectionId, unit), why);
    } catch (error) {
      await saveJob({ ...job, lastError: `Provider 暂不可用: ${errMsg(error)}` });
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + RETRY_DELAY_MS);
    }
  }

  private async resumePrepared(job: Job): Promise<void> {
    const unit = job.current;
    if (!unit || unit.phase !== 'prepared') return;
    if (unit.kind === 'extract') {
      const meta = await getChunkMeta(job.id, Number(unit.ref));
      if (!meta) return this.failUnit(job, `chunk ${unit.ref} 元数据缺失`);
      const text = await getChunkTextById(meta.id);
      if (text == null) return this.failUnit(job, `chunk ${unit.ref} 内容缺失`);
      return this.submitPrepared(job, buildExtractionPrompt(unit.marker, text), meta);
    }
    const state = job.reduceState;
    const group = state?.groups[state.nextGroup];
    if (!state || !group) return this.failJob(job, '归并状态缺失');
    const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
    if (results.length !== group.end - group.start) return this.failJob(job, '归并输入缺失');
    return this.submitPrepared(job, buildReducePrompt(unit.marker, results.map((result) => JSON.stringify(result.parsed))));
  }

  private async handleInspection(job: Job, inspection: ProviderInspection, why: string): Promise<void> {
    if (!job.current) return;
    if (inspection.remoteRef && inspection.remoteRef !== job.current.remoteRef) {
      job = { ...job, current: { ...job.current, remoteRef: inspection.remoteRef } };
      await saveJob(job);
    }
    if (inspection.status === 'complete') {
      const collecting = job.status === 'waiting' ? await this.to(job, 'collecting') : job;
      await this.collectCurrent(collecting, inspection.reply);
    } else if (inspection.status === 'generating') {
      this.host.scheduleAlarm(TIMEOUT_ALARM(job.id), Date.now() + REGEN_CHECK_MS);
    } else if (inspection.status === 'rate_limited') {
      await this.noteRateLimit(job, inspection.detail, inspection.retryAfterMs);
    } else if (inspection.status === 'unavailable') {
      await saveJob({ ...job, lastError: inspection.detail });
      this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + inspection.retryAfterMs);
    } else {
      await this.failJob(job, `无法对账(${why})，已停止自动重发以避免重复发送: ${inspection.detail}`, true);
    }
  }

  private async noteRateLimit(job: Job, detail: string, retryAfterMs: number): Promise<void> {
    job = { ...job, current: job.current ? { ...job.current, rateLimited: true } : null, lastError: detail,
      stats: { ...job.stats, rateLimitHits: job.stats.rateLimitHits + 1 } };
    await saveJob(job);
    if (job.status !== 'waiting' && job.status !== 'paused') job = await this.to(job, 'waiting');
    this.host.scheduleAlarm(RESUME_ALARM(job.id), Date.now() + Math.max(RETRY_DELAY_MS, retryAfterMs));
  }

  private async resend(job: Job, reason: string, force = false): Promise<void> {
    const unit = job.current;
    if (!unit) return this.pump(job.id);
    if (!force && unit.attempt >= job.config.maxAttempts && !unit.rateLimited) return this.failUnit(job, reason);
    const prevAttempt = Math.max(0, unit.attempt - (unit.rateLimited ? 1 : 0));
    if (unit.kind === 'extract') {
      const meta = await getChunkMeta(job.id, Number(unit.ref));
      if (!meta) return this.failUnit(job, `chunk ${unit.ref} 元数据缺失`);
      const text = await getChunkTextById(meta.id);
      if (text == null) return this.failUnit(job, `chunk ${unit.ref} 内容缺失`);
      return this.dispatchUnit(job, { kind: 'extract', ref: unit.ref, prevAttempt },
        (marker) => buildExtractionPrompt(marker, text), meta);
    }
    const state = job.reduceState;
    const group = state?.groups[state.nextGroup];
    if (!state || !group) return this.failJob(job, '归并状态缺失');
    const results = await this.loadResults(state.inputIds.slice(group.start, group.end));
    return this.dispatchUnit(job, { kind: 'reduce', ref: unit.ref, prevAttempt },
      (marker) => buildReducePrompt(marker, results.map((r) => JSON.stringify(r.parsed))));
  }

  private async collectCurrent(job: Job, raw: string): Promise<void> {
    const unit = job.current;
    if (!unit) return;
    const parsed = sanitizeExtraction(raw);
    if (!parsed) return this.resend(job, '回复无法解析为知识 JSON');
    if (unit.kind === 'extract') {
      const index = Number(unit.ref);
      const id = `${job.id}:c${index}:a${unit.attempt}`;
      const result: ResultRecord = { id, jobId: job.id, kind: 'extract', level: 0, ref: unit.ref,
        sourceIds: [`${job.id}:${index}`], raw, parsed, createdAt: Date.now() };
      const next = await commitCollected(job.id, unit.marker, result, 'processing', index);
      if (next?.status !== 'paused') await this.pump(job.id);
      return;
    }
    const state = job.reduceState;
    if (!state) return this.failJob(job, '归并状态缺失');
    const groupIndex = Number(unit.ref.split('-')[1]);
    const group = state.groups[groupIndex];
    if (!Number.isInteger(groupIndex) || !group) return this.failJob(job, `非法归并引用: ${unit.ref}`);
    const id = `${job.id}:r${state.level}g${groupIndex}:a${unit.attempt}`;
    const result: ResultRecord = { id, jobId: job.id, kind: 'reduce', level: state.level, ref: unit.ref,
      sourceIds: state.inputIds.slice(group.start, group.end), raw, parsed, createdAt: Date.now() };
    const reduceState = { ...state, nextGroup: state.nextGroup + 1, outputIds: [...state.outputIds, id] };
    const next = await commitCollected(job.id, unit.marker, result, 'reducing', undefined, reduceState);
    if (next?.status !== 'paused') await this.pump(job.id);
  }

  private async beginReduce(job: Job): Promise<void> {
    const metas = (await chunkMetasByJob(job.id)).sort((a, b) => a.index - b.index);
    const ids = metas.filter((meta) => meta.status === 'done' && meta.resultId).map((meta) => meta.resultId!);
    if (ids.length === 0) return this.failJob(job, '没有任何提炼结果，无法归并');
    if (ids.length === 1) return this.finalize(job, ids[0]!);
    const results = await this.loadResults(ids);
    if (results.length !== ids.length) return this.failJob(job, '提炼结果记录缺失');
    const groups = planGroups(results.map((result) => JSON.stringify(result.parsed).length),
      { fanIn: job.config.fanIn, maxChars: job.config.reduceMaxInputChars });
    if (groups.length >= ids.length) return this.failJob(job, '提炼结果超过归并预算且无法收敛；请提高归并预算或缩小分块');
    job = { ...job, reduceState: { level: 1, inputIds: ids, groups, nextGroup: 0, outputIds: [] } };
    await saveJob(job);
    job = await this.to(job, 'reducing');
    await this.dispatchNextReduce(job);
  }

  private async finalize(job: Job, resultId: string): Promise<void> {
    job = { ...job, finalResultId: resultId, current: null, lastError: null };
    await saveJob(job);
    if (job.status !== 'completed') job = await this.to(job, 'completed');
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.clearAlarm(RESUME_ALARM(job.id));
    if ((await getActiveJobId()) === job.id) await setActiveJobId(null);
  }

  private async failUnit(job: Job, reason: string): Promise<void> {
    const unit = job.current;
    if (unit?.kind === 'extract') {
      const next = await commitUnitFailure(job.id, unit.marker, reason, Number(unit.ref));
      if (!next || next.status === 'paused') return;
      const processing = next.status === 'processing' ? next : await this.to(next, 'processing');
      await this.pump(processing.id);
      return;
    }
    await this.failJob(job, reason);
  }

  private async failJob(job: Job, reason: string, preserveCurrent = false): Promise<void> {
    job = { ...job, lastError: reason, current: preserveCurrent ? job.current : null };
    await saveJob(job);
    if (job.status !== 'failed') await this.to(job, 'failed');
    this.host.clearAlarm(TIMEOUT_ALARM(job.id));
    this.host.clearAlarm(RESUME_ALARM(job.id));
  }

  private async loadResults(ids: string[]): Promise<ResultRecord[]> {
    const values = await Promise.all(ids.map((id) => getResult(id)));
    return values.filter((value): value is ResultRecord => value != null);
  }
}
