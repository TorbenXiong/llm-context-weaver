import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, EngineHost } from '../src/core/engine/engine';
import type { ProviderInspection, ProviderPrepareOutcome, ProviderSubmitOutcome } from '../src/core/provider';
import type * as JobStore from '../src/core/storage/jobStore';
import { DEFAULT_JOB_CONFIG, type CurrentUnit, type Job, type JobConfig, type ResultRecord } from '../src/core/types';

const CONNECTION_ID = 'fake-connection';
const timeoutAlarm = (jobId: string): string => `lcw:t:${jobId}`;
const resumeAlarm = (jobId: string): string => `lcw:r:${jobId}`;

class FakeProvider {
  connectionId = CONNECTION_ID;
  accountKey: string | undefined;
  accountLabel: string | undefined;
  connectCalls = 0;
  sentPrompts: string[] = [];
  newSessions = 0;
  submitOutcome: ProviderSubmitOutcome | null = null;
  inspection: ProviderInspection | null = null;
  inspectionQueue: ProviderInspection[] = [];
  prepared: CurrentUnit[] = [];
  cleanupCalls: string[][] = [];
  dispatchCooldownMs: number | null = null;
  prepareOutcome: ProviderPrepareOutcome | null = null;

  prepare(unit: CurrentUnit): ProviderPrepareOutcome | void {
    this.prepared.push(unit);
    if (unit.phase === 'prepared') this.newSessions++;
    const outcome = this.prepareOutcome;
    this.prepareOutcome = null;
    return outcome ?? undefined;
  }

  submit(prompt: string): ProviderSubmitOutcome {
    this.sentPrompts.push(prompt);
    return this.submitOutcome ?? { status: 'accepted', remoteRef: `remote-${this.sentPrompts.length}` };
  }

  getDispatchCooldown(_job: Job, now: number): { until: number; detail: string } | null {
    return this.dispatchCooldownMs == null
      ? null
      : { until: now + this.dispatchCooldownMs, detail: '测试主动冷却' };
  }

  inspect(unit: CurrentUnit): ProviderInspection {
    if (this.inspectionQueue.length > 0) return this.inspectionQueue.shift()!;
    if (this.inspection) return this.inspection;
    const ref = /ref=([\w.-]+)/.exec(unit.marker)?.[1] ?? 'unknown';
    if (unit.kind === 'index') {
      return {
        status: 'complete',
        remoteRef: unit.remoteRef,
        reply: '```json\n' + JSON.stringify({
          units: [{ id: `chunk-${ref}-1`, topic: `topic:${ref}`, sourceHints: [`source:${ref}`] }],
        }) + '\n```',
      };
    }
    if (unit.kind === 'format') {
      return {
        status: 'complete',
        remoteRef: unit.remoteRef,
        reply: '```json\n' + JSON.stringify({
          categories: [{ name: '统一分类', meaning: '测试知识', aliases: ['事实'] }],
          rules: { time: 'YYYY-MM-DD', topic: '简短名词', content: '保留事实', details: '键值对', merge: '仅合并重复项' },
        }) + '\n```',
      };
    }
    return {
      status: 'complete',
      remoteRef: unit.remoteRef,
      reply: '```json\n' + JSON.stringify({
        knowledge: [{ category: '事实', topic: `topic:${ref}`, content: `fact:${ref}` }],
      }) + '\n```',
    };
  }

  cleanupSessions(refs: readonly string[]): { deletedRefs: string[]; missingRefs: string[] } {
    this.cleanupCalls.push([...refs]);
    return { deletedRefs: [...refs], missingRefs: [] };
  }
}

interface Harness {
  engine: Engine;
  store: typeof JobStore;
  provider: FakeProvider;
  alarms: Map<string, number>;
  config: JobConfig;
}

async function setup(): Promise<Harness> {
  vi.resetModules();
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  const engineModule = await import('../src/core/engine/engine');
  const store = await import('../src/core/storage/jobStore');
  const provider = new FakeProvider();
  const alarms = new Map<string, number>();
  const host: EngineHost = {
    connect: async () => {
      provider.connectCalls++;
      return provider.connectionId;
    },
    getAccountIdentity: async () => provider.accountKey ? { key: provider.accountKey, label: provider.accountLabel ?? provider.accountKey } : undefined,
    prepare: async (_connectionId, unit) => provider.prepare(unit),
    submit: async (_connectionId, _marker, prompt) => provider.submit(prompt),
    inspect: async (_connectionId, unit) => provider.inspect(unit),
    getDispatchCooldown: async (job, _inputChars, now) => provider.getDispatchCooldown(job, now),
    cleanupSessions: async (_connectionId, refs) => provider.cleanupSessions(refs),
    scheduleAlarm: (name, when) => void alarms.set(name, when),
    clearAlarm: (name) => void alarms.delete(name),
    log: () => undefined,
  };
  // 既有 Engine 回归测试覆盖直接流程；多阶段流程在专门用例中验证。
  const config = {
    ...DEFAULT_JOB_CONFIG,
    pipelineMode: 'direct' as const,
    sendDelayMs: 0,
    fanIn: 3,
  };
  return { engine: new engineModule.Engine(host), store, provider, alarms, config };
}

async function makeJob(h: Harness, chunks: string[]): Promise<Job> {
  const job = await h.store.createJob('测试任务', h.config, 'fake', chunks.length);
  await h.store.addChunks(job.id, chunks);
  return job;
}

async function runToEnd(h: Harness, jobId: string, max = 60): Promise<Job> {
  for (let index = 0; index < max; index++) {
    const job = await h.store.getJob(jobId);
    if (!job) throw new Error('job missing');
    if (['completed', 'failed', 'canceled'].includes(job.status)) return job;
    await h.engine.onGenerationEnd(CONNECTION_ID);
  }
  throw new Error('未在限定轮次内结束');
}

let h: Harness;
beforeEach(async () => { h = await setup(); });

describe('engine e2e', () => {
  it('同一账号通过 Provider 探测补齐标签，不依赖 ready 事件携带标签', async () => {
    h.provider.accountKey = 'account-a';
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    const started = (await h.store.getJob(job.id))!;
    await h.store.saveJob({ ...started, providerAccountLabel: undefined });
    h.provider.accountLabel = '177******46';
    h.provider.inspection = { status: 'generating' };
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.providerAccountLabel).toBe('177******46');
  });

  it('已清除摘要后切回限流账号仍等待，且不创建新网页会话', async () => {
    h.provider.accountKey = 'account-a';
    const job = await makeJob(h, ['only']);
    const until = Date.now() + 60 * 60_000;
    await h.store.saveJob({ ...job, status: 'processing', providerAccountKey: 'account-b',
      providerRateLimits: [{ providerId: 'fake', accountKey: 'account-a', kind: 'official', occurredAt: Date.now(), limitedUntil: until }] });
    await h.engine.pump(job.id);
    const waiting = (await h.store.getJob(job.id))!;
    expect(waiting.sessionCooldownUntil).toBe(until);
    expect(waiting.status).toBe('waiting');
    expect(h.provider.newSessions).toBe(0);
    expect(h.provider.sentPrompts).toHaveLength(0);
  });

  it('清除失效冷却后不会被调度中的旧 Job 快照重新写回', async () => {
    h.provider.accountKey = 'account-a';
    const job = await makeJob(h, ['only']);
    await h.store.saveJob({ ...job, status: 'processing', providerAccountKey: 'account-a',
      sessionCooldownUntil: Date.now() - 1, sessionCooldownReason: '过期冷却' });
    await h.engine.pump(job.id);
    expect((await h.store.getJob(job.id))?.sessionCooldownUntil).toBeUndefined();
    expect(h.provider.sentPrompts).toHaveLength(1);
  });

  it('新账号官方限流样本不包含旧账号流量，任务累计仍包含全部账号', async () => {
    h.provider.accountKey = 'account-b';
    const job = await makeJob(h, ['only']);
    const now = Date.now();
    await h.store.saveJob({ ...job, status: 'processing', providerConnectionId: CONNECTION_ID, providerAccountKey: 'account-b',
      trafficHistory: [
        { marker: 'a', accountKey: 'account-a', submittedAt: now - 100, inputChars: 6_000_000, outputChars: 100, completedAt: now - 80 },
        { marker: 'b', accountKey: 'account-b', submittedAt: now - 50, inputChars: 200, outputChars: 20, completedAt: now - 30 },
      ] });
    await h.store.setActiveJobId(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, 'B 限流', 60 * 60_000, undefined, 'account-b');
    const event = (await h.store.getJob(job.id))!.rateLimitEvents!.at(-1)!;
    expect(event.intervalInputChars).toBe(200);
    expect(event.intervalOutputChars).toBe(20);
    expect(event.cumulativeInputChars).toBe(6_000_200);
    expect(event.cumulativeOutputChars).toBe(120);
  });

  it('官方限流按账号隔离，切换到新账号后可以继续当前任务', async () => {
    h.provider.accountKey = 'account-a';
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, '账号 A 限流', 60 * 60_000, undefined, 'account-a');
    let limited = await h.store.getJob(job.id);
    expect(limited?.providerRateLimits).toHaveLength(1);
    expect(limited?.providerRateLimits?.[0]?.accountKey).toBe('account-a');

    h.provider.accountKey = 'account-b';
    await h.engine.onAdapterReady(CONNECTION_ID, 'account-b');
    limited = await h.store.getJob(job.id);
    expect(limited?.current?.rateLimited).toBeUndefined();
    expect(limited?.providerRateLimits).toHaveLength(1);
    expect(limited?.providerRateLimits?.[0]?.accountKey).toBe('account-a');

    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('账号 key 已存在但标签缺失时，后续 ready 事件会补齐当前账号展示名', async () => {
    h.provider.accountKey = 'account-a';
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    const started = await h.store.getJob(job.id);
    await h.store.saveJob({ ...started!, providerAccountLabel: undefined });
    await h.engine.onAdapterReady(CONNECTION_ID, 'account-a');
    expect((await h.store.getJob(job.id))?.providerAccountLabel).toBeUndefined();

    await h.engine.onAdapterReady(CONNECTION_ID, 'account-a', '177******46');
    expect((await h.store.getJob(job.id))?.providerAccountLabel).toBe('177******46');
  });

  it('同一任务可分别记录多个账号的官方限流', async () => {
    const job = await makeJob(h, ['only']);
    h.provider.accountKey = 'account-a';
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, '账号 A 限流', 60 * 60_000, undefined, 'account-a');
    h.provider.accountKey = 'account-b';
    await h.engine.onRateLimited(CONNECTION_ID, '账号 B 限流', 60 * 60_000, undefined, 'account-b');
    const saved = await h.store.getJob(job.id);
    expect(saved?.providerRateLimits?.map((entry) => entry.accountKey)).toEqual(['account-a', 'account-b']);
  });

  it('换号时清除旧版本未绑定账号的主动冷却', async () => {
    h.provider.accountKey = 'account-a';
    const job = await makeJob(h, ['only']);
    await h.store.saveJob({
      ...job,
      status: 'processing',
      providerAccountKey: 'account-a',
      sessionCooldownUntil: Date.now() + 60 * 60_000,
      sessionCooldownReason: 'DeepSeek 主动节流：旧账号窗口',
    });
    await h.store.setActiveJobId(job.id);
    h.provider.accountKey = 'account-b';
    await h.engine.onAdapterReady(CONNECTION_ID, 'account-b', '账号 B');
    const switched = await h.store.getJob(job.id);
    expect(switched?.sessionCooldownUntil).toBeUndefined();
    expect(switched?.providerAccountKey).toBe('account-b');
  });

  it('知识结果先抽样生成动态格式规范，再分批统一并最终归档', async () => {
    const job = await makeJob(h, ['第一块', '第二块', '第三块']);
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    const results = await h.store.resultsByJob(job.id);
    expect(done.status).toBe('completed');
    expect(results.filter((result) => result.kind === 'extract')).toHaveLength(3);
    expect(results.filter((result) => result.kind === 'format')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'normalize')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'reduce')).toHaveLength(1);
    expect(done.stats).toMatchObject({ sent: 6, collected: 6 });
    const stages = h.provider.sentPrompts.map((prompt) =>
      ['目标处理', '动态格式规范', '按规范统一格式', '最终交付'].find((stage) => prompt.includes(`阶段：${stage}`)) ?? 'extract');
    expect(stages.slice(-3)).toEqual(['动态格式规范', '按规范统一格式', '最终交付']);
    const planPrompt = h.provider.sentPrompts.find((prompt) => prompt.includes('阶段：动态格式规范'))!;
    expect(planPrompt).toContain('topic:0');
    expect(planPrompt).toContain('topic:1');
    expect(planPrompt).toContain('topic:2');
    const normalizePrompt = h.provider.sentPrompts.find((prompt) => prompt.includes('阶段：按规范统一格式'))!;
    expect(normalizePrompt).toContain('aliases');
    expect(normalizePrompt).toContain('统一分类');
  });

  it('格式规范阶段暂停后可从持久化状态恢复', async () => {
    const job = await makeJob(h, ['第一块', '第二块']);
    await h.engine.startJob(job.id);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    const planning = await h.store.getJob(job.id);
    expect(planning?.formatState?.phase).toBe('planning');
    await h.engine.pause(job.id);
    await h.engine.resume(job.id);
    const done = await runToEnd(h, job.id);
    expect(done.status).toBe('completed');
    expect(done.formatState).toBeNull();
  });

  it('多阶段流程先建立索引，再把索引与原文交给目标处理，最后归并', async () => {
    h.config = { ...h.config, pipelineMode: 'staged' };
    const job = await makeJob(h, ['第一块原文', '第二块原文']);
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    const results = await h.store.resultsByJob(job.id);
    expect(done.status).toBe('completed');
    expect(results.filter((result) => result.kind === 'index')).toHaveLength(2);
    expect(results.filter((result) => result.kind === 'extract')).toHaveLength(2);
    expect(results.filter((result) => result.kind === 'format')).toHaveLength(2);
    expect(results.filter((result) => result.kind === 'reduce')).toHaveLength(1);
    const formatPrompts = h.provider.sentPrompts.filter((prompt) => prompt.includes('阶段：动态格式规范'));
    expect(formatPrompts).toHaveLength(2);
    expect(h.provider.sentPrompts.findIndex((prompt) => prompt.includes('阶段：动态格式规范')))
      .toBeLessThan(h.provider.sentPrompts.findIndex((prompt) => prompt.includes('阶段：目标相关索引')));
    const extractionPrompt = h.provider.sentPrompts.find((prompt) => prompt.includes('阶段：目标处理'))!;
    expect(extractionPrompt).toContain('格式规范（后续沿用）');
    expect(extractionPrompt).toContain('"categories"');
    const indexPositions = h.provider.sentPrompts
      .map((prompt, index) => prompt.includes('阶段：目标相关索引') ? index : -1)
      .filter((index) => index >= 0);
    const processPositions = h.provider.sentPrompts
      .map((prompt, index) => prompt.includes('阶段：目标处理') ? index : -1)
      .filter((index) => index >= 0);
    expect(indexPositions).toHaveLength(2);
    expect(processPositions).toHaveLength(2);
    expect(Math.max(...indexPositions)).toBeLessThan(Math.min(...processPositions));
    const distillPrompt = h.provider.sentPrompts.find((prompt) => prompt.includes('阶段：目标处理'))!;
    expect(distillPrompt).toContain('相关内容索引');
    expect(distillPrompt).toContain('topic:0');
    expect(distillPrompt).toContain('第一块原文');
  });

  it('3 块提取、格式统一和归并后完成，核心只保存不透明 Provider 引用', async () => {
    const job = await makeJob(h, ['一', '二', '三']);
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    expect(done.status).toBe('completed');
    expect(done.providerId).toBe('fake');
    expect(done.providerConnectionId).toBe(CONNECTION_ID);
    expect(done.stats).toMatchObject({ sent: 6, collected: 6 });
    expect(done.trafficHistory).toHaveLength(6);
    expect(done.trafficHistory?.every((sample) => sample.inputChars > 0 && (sample.outputChars ?? 0) > 0)).toBe(true);
    expect(h.provider.newSessions).toBe(6);
    expect((await h.store.resultsByJob(job.id))).toHaveLength(6);
    expect(done.providerSessionRefs).toHaveLength(6);
  });

  it('清理任务对应的 Provider 网页会话时保留本地结果', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await runToEnd(h, job.id);
    await h.engine.cleanupSessions(job.id);
    const cleaned = await h.store.getJob(job.id);
    expect(h.provider.cleanupCalls).toHaveLength(1);
    expect(h.provider.cleanupCalls[0]).toEqual(['remote-1']);
    expect(cleaned?.providerSessionRefs).toEqual([]);
    expect(cleaned?.status).toBe('completed');
    expect(await h.store.resultsByJob(job.id)).toHaveLength(1);
  });

  it('暂停不推进；恢复后先对账在途 claim', async () => {
    const job = await makeJob(h, ['a', 'b']);
    await h.engine.startJob(job.id);
    await h.engine.pause(job.id);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    expect((await h.store.getJob(job.id))?.status).toBe('paused');
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('sent');
    await h.store.setActiveJobId(null); // 模拟暂停期间扩展重载，活动任务指针丢失
    await h.engine.resume(job.id);
    expect(await h.store.getActiveJobId()).toBe(job.id);
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('done');
    expect((await runToEnd(h, job.id)).status).toBe('completed');
  });

  it('扩展重载时活动指针丢失，仍能从 waiting 任务恢复调度', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    expect((await h.store.getJob(job.id))?.status).toBe('waiting');
    await h.store.setActiveJobId(null);
    h.alarms.clear();

    await h.engine.resumeActive();

    expect(await h.store.getActiveJobId()).toBe(job.id);
    expect(h.alarms.has(resumeAlarm(job.id))).toBe(true);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('没有 generationEnd 时，短周期主动对账仍可及时收单', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    expect(h.alarms.has(resumeAlarm(job.id))).toBe(true);
    expect(h.alarms.has(timeoutAlarm(job.id))).toBe(true);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('深度思考任务观察到完整回复后等待稳定窗口再收集', async () => {
    h.config = { ...h.config, deepThinking: true };
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    let waiting = await h.store.getJob(job.id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.current?.completionObservedAt).toBeTypeOf('number');
    expect(waiting?.stats.collected).toBe(0);

    await h.store.saveJob({
      ...waiting!,
      current: { ...waiting!.current!, completionObservedAt: Date.now() - 11_000 },
    });
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('Provider 限流后等待其建议的退避时间再以相同 attempt 重试', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    const limitedAt = Date.now();
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 60 * 60_000);
    const waiting = await h.store.getJob(job.id);
    expect(waiting?.current?.rateLimited).toBe(true);
    expect(waiting?.stats.rateLimitHits).toBe(1);
    expect(waiting?.rateLimitEvents?.[0]).toMatchObject({ sentCount: 1, retryAfterMs: 60 * 60_000 });
    expect(waiting?.rateLimitEvents?.[0]?.inputChars).toBeGreaterThan(0);
    expect(waiting?.rateLimitEvents?.[0]?.cumulativeInputChars)
      .toBe(waiting?.rateLimitEvents?.[0]?.intervalInputChars);
    expect(h.alarms.has(timeoutAlarm(job.id))).toBe(false);
    expect(h.alarms.get(resumeAlarm(job.id))!).toBeGreaterThanOrEqual(limitedAt + 60 * 60_000);

    await h.engine.onRateLimited(CONNECTION_ID, '重复限流事件', 60 * 60_000);
    expect((await h.store.getJob(job.id))?.stats.rateLimitHits).toBe(1);

    const stillLimited = await h.store.getJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.current?.rateLimited).toBe(true);
    expect(h.provider.sentPrompts).toHaveLength(1);

    await h.store.saveJob({
      ...stillLimited!,
      current: { ...stillLimited!.current!, retryAfterAt: Date.now() - 1 },
      sessionCooldownUntil: Date.now() - 1,
    });
    await h.engine.onAlarm(resumeAlarm(job.id));
    const retried = await h.store.getJob(job.id);
    expect(retried?.current?.attempt).toBe(1);
    expect(retried?.current?.rateLimited).not.toBe(true);
    expect(h.provider.sentPrompts).toHaveLength(2);
  });

  it('保存的标签页连接失效后重新绑定并对账，不重复发送当前单元', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    expect(h.provider.sentPrompts).toHaveLength(1);
    h.provider.connectionId = 'replacement-connection';

    await h.engine.onAlarm(resumeAlarm(job.id));

    const recovered = await h.store.getJob(job.id);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.providerConnectionId).toBe('replacement-connection');
    expect(recovered?.stats.sent).toBe(1);
    expect(h.provider.sentPrompts).toHaveLength(1);
    expect(h.provider.connectCalls).toBeGreaterThan(1);
  });

  it('官方限流后不自动检查，用户确认手工续写成功才对账', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 65 * 60_000, 35 * 60_000);
    let limited = await h.store.getJob(job.id);
    expect(limited?.current?.continuationProbeAt).toBeUndefined();
    expect(h.alarms.get(resumeAlarm(job.id))).toBe(limited?.sessionCooldownUntil);

    h.provider.inspectionQueue = [{
      status: 'complete',
      remoteRef: 'remote-1',
      reply: '```json\n{"knowledge":[{"category":"事实","topic":"继续生成","content":"继续生成成功"}]}\n```',
    }];
    await h.engine.manualContinue(job.id);
    const checked = await h.store.getJob(job.id);
    expect(checked?.current).toBeNull();
    expect(checked?.stats.collected).toBe(1);
    expect(checked?.sessionCooldownUntil).toBeUndefined();
    expect(h.provider.sentPrompts).toHaveLength(1);
  });

  it('手工干预确认失败时不按临时错误频繁重试', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 65 * 60_000, 35 * 60_000);
    const limited = await h.store.getJob(job.id);
    h.provider.inspectionQueue = [{
      status: 'unavailable',
      detail: '续写按钮未响应',
      retryAfterMs: 5_000,
      remoteRef: 'remote-1',
    }];
    await h.engine.manualContinue(job.id);
    const checked = await h.store.getJob(job.id);
    expect(checked?.current?.continuationProbeAt).toBeUndefined();
    expect(h.alarms.get(resumeAlarm(job.id))).toBe(checked?.current?.retryAfterAt);
    expect(h.provider.inspectionQueue).toHaveLength(0);
  });

  it('暂停后继续不会绕过官方限流退避时间', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 60 * 60_000);
    await h.engine.pause(job.id);
    await h.engine.resume(job.id);
    const waiting = await h.store.getJob(job.id);
    expect(waiting?.current?.rateLimited).toBe(true);
    expect(h.provider.sentPrompts).toHaveLength(1);
    expect(h.alarms.get(resumeAlarm(job.id))!).toBeGreaterThan(Date.now());
  });

  it('官方冷却期间收到人工续写结束事件时只读对账并收集结果', async () => {
    const job = await makeJob(h, ['only', 'next']);
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 60 * 60_000);
    h.provider.inspectionQueue = [{ status: 'generating', remoteRef: 'remote-1' }];
    await h.engine.manualContinue(job.id);
    h.provider.inspectionQueue = [{
      status: 'complete',
      remoteRef: 'remote-1',
      reply: '```json\n{"knowledge":[{"category":"事实","topic":"人工续写","content":"已完成"}]}\n```',
    }];
    await h.engine.onGenerationEnd(CONNECTION_ID);
    const reconciled = await h.store.getJob(job.id);
    // 当前会话人工续写成功后，收集结果会清除旧的任务级冷却并立即调度下一块。
    expect(reconciled?.status).toBe('waiting');
    expect(reconciled?.current?.ref).toBe('1');
    expect(reconciled?.stats.collected).toBe(1);
    expect(reconciled?.sessionCooldownUntil).toBeUndefined();
    expect(reconciled?.sessionCooldownReason).toBeUndefined();
    expect(h.provider.sentPrompts).toHaveLength(2);
    expect(reconciled?.eventLog?.some((event) => event.kind === 'generation-end')).toBe(true);
    expect(reconciled?.eventLog?.some((event) => event.detail.includes('限流期间当前会话已恢复'))).toBe(true);
  });

  it('空闲间隙收到官方限流事件时也会保存任务级冷却', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    const active = await h.store.getJob(job.id);
    await h.store.saveJob({ ...active!, current: null, status: 'processing' });
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 60 * 60_000);
    const limited = await h.store.getJob(job.id);
    expect(limited?.current).toBeNull();
    expect(limited?.sessionCooldownUntil).toBeGreaterThan(Date.now());
    expect(limited?.sessionCooldownStartedAt).toBeTypeOf('number');
    expect(limited?.sessionCooldownStartedAt).toBe(limited?.rateLimitEvents?.at(-1)?.occurredAt);
    expect(limited?.stats.rateLimitHits).toBe(1);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect(h.provider.sentPrompts).toHaveLength(1);
    await h.engine.onRateLimited(CONNECTION_ID, '同一页面提示再次扫描', 60 * 60_000);
    expect((await h.store.getJob(job.id))?.stats.rateLimitHits).toBe(1);
  });

  it('人工重试失败分块时不会清除尚未到期的官方冷却', async () => {
    const job = await makeJob(h, ['failed']);
    const meta = await h.store.getChunkMeta(job.id, 0);
    await h.store.saveChunkMeta({ ...meta!, status: 'failed', error: '测试失败', attempts: 1 });
    await h.store.saveJob({
      ...job,
      status: 'failed',
      failedChunks: [0],
      sessionCooldownUntil: Date.now() + 60 * 60_000,
      sessionCooldownReason: 'Provider 官方限流，60 分钟后重试',
    });
    await h.engine.retryFailed(job.id);
    const retried = await h.store.getJob(job.id);
    expect(retried?.sessionCooldownUntil).toBeGreaterThan(Date.now());
    expect(h.provider.sentPrompts).toHaveLength(0);
  });

  it('后续限流事件的累计输入包含此前触发限流的请求', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await h.engine.onRateLimited(CONNECTION_ID, '第一次限流', 60 * 60_000);
    const first = await h.store.getJob(job.id);
    const firstInput = first?.rateLimitEvents?.[0]?.cumulativeInputChars ?? 0;
    await h.store.saveJob({
      ...first!,
      current: { ...first!.current!, rateLimited: undefined, retryAfterAt: undefined, phase: 'prepared' },
      sessionCooldownUntil: Date.now() - 1,
    });
    await h.engine.onRateLimited(CONNECTION_ID, '第二次限流', 60 * 60_000);
    const second = await h.store.getJob(job.id);
    const secondEvent = second?.rateLimitEvents?.[1];
    expect(secondEvent?.cumulativeInputChars).toBeGreaterThanOrEqual(firstInput);
    expect(secondEvent?.cumulativeInputChars).toBe(
      (secondEvent?.intervalInputChars ?? 0) + firstInput,
    );
  });

  it('Provider 按输入输出策略主动冷却，再发送下一个会话', async () => {
    const job = await makeJob(h, ['only']);
    h.provider.dispatchCooldownMs = 10 * 60_000;
    await h.engine.startJob(job.id);
    const cooling = await h.store.getJob(job.id);
    expect(cooling?.sessionCooldownUntil).toBeTypeOf('number');
    expect(cooling?.sessionCooldownStartedAt).toBeTypeOf('number');
    expect(cooling?.sessionCooldownReason).toContain('主动');
    expect(h.provider.sentPrompts).toHaveLength(0);
    expect(h.alarms.get(resumeAlarm(job.id))!).toBeGreaterThanOrEqual(Date.now() + 9 * 60_000);

    await h.engine.onAlarm(resumeAlarm(job.id));
    expect(h.provider.sentPrompts).toHaveLength(0);

    h.provider.dispatchCooldownMs = null;
    await h.store.saveJob({ ...cooling!, sessionCooldownUntil: Date.now() - 1 });
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect(h.provider.sentPrompts).toHaveLength(1);
    expect((await h.store.getJob(job.id))?.sessionCooldownStartedAt).toBeUndefined();
  });

  it('回复节点晚于生成状态挂载时，missing 只等待不误判失败', async () => {
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [
      { status: 'missing', detail: '回复节点尚未挂载' },
      h.provider.inspect({
        kind: 'extract', ref: '0', attempt: 1, marker: '[LCW test]', phase: 'acknowledged', remoteRef: 'remote-1',
      }),
    ];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    const waiting = await h.store.getJob(job.id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.lastError).toBeNull();
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('自定义任务保留自定义 JSON', async () => {
    h.config = { ...h.config, taskKind: 'custom' };
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [
      {
        status: 'complete',
        remoteRef: 'remote-1',
        reply: '```json\n{"knowledge_entries":[{"title":"正常结果"}]}\n```',
      },
    ];

    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));

    const retrying = await h.store.getJob(job.id);
    expect(retrying?.status).toBe('completed');
    expect(retrying?.stats).toMatchObject({ sent: 1, collected: 1 });
    expect((await h.store.resultsByJob(job.id))[0]?.parsed).toContain('knowledge_entries');
  });

  it('知识任务拒绝缺少统一条目字段的结构并自动重试', async () => {
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [
      {
        status: 'complete',
        remoteRef: 'remote-1',
        reply: '```json\n{"knowledge":[{"date":"2026-09-01","content":"错误结构"}]}\n```',
      },
      {
        status: 'complete',
        remoteRef: 'remote-2',
        reply: '```json\n' + JSON.stringify({
          knowledge: [{ category: '事实', topic: '正确事实', content: '正确事实', time: '2026-09-01' }],
        }) + '\n```',
      },
    ];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.current?.attempt).toBe(2);
    await h.engine.onAlarm(resumeAlarm(job.id));
    const done = await h.store.getJob(job.id);
    expect(done?.status).toBe('completed');
    expect((await h.store.resultsByJob(job.id))[0]?.parsed).toMatchObject({
      knowledge: [{ category: '事实', topic: '正确事实', content: '正确事实', time: '2026-09-01' }],
    });
  });

  it('JSON 持续无法解析时达到最大尝试次数后失败，不无限重试', async () => {
    h.config = { ...h.config, maxAttempts: 2 };
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [
      { status: 'complete', remoteRef: 'remote-1', reply: '{"knowledge":' },
      { status: 'complete', remoteRef: 'remote-2', reply: '仍然不是 JSON' },
    ];

    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.current?.attempt).toBe(2);
    await h.engine.onAlarm(resumeAlarm(job.id));

    const failed = await h.store.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toContain('有 1 个分块失败，请重试后再归并');
    expect(failed?.lastError).toContain('回复结构异常');
    expect(failed?.stats).toMatchObject({ sent: 2, collected: 0 });
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('failed');
  });

  it('结构可解析的回复直接收集，不因内容措辞触发质量重试', async () => {
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [
      {
        status: 'complete',
        remoteRef: 'remote-1',
        reply: '```json\n{"knowledge":[{"category":"事实","topic":"回复","content":"这个问题暂时无法回答，让我们换个话题再聊聊吧。"}]}\n```',
      },
    ];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    const done = await h.store.getJob(job.id);
    expect(done?.status).toBe('completed');
    expect(done?.stats).toMatchObject({ sent: 1, collected: 1 });
    expect(done?.eventLog?.some((event) => event.kind.startsWith('quality-'))).toBe(false);
    expect((await h.store.resultsByJob(job.id))[0]?.parsed).toMatchObject({
      knowledge: [{ topic: '回复', content: '这个问题暂时无法回答，让我们换个话题再聊聊吧。' }],
    });
  });

  it('远端会话被删除后，Provider 可安全创建新会话并递增 attempt 重试', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    h.provider.prepareOutcome = {
      status: 'retry_current',
      detail: 'DeepSeek 原网页会话已被删除，已准备创建新会话重试当前单元',
    };
    h.provider.inspectionQueue = [h.provider.inspect({
      kind: 'extract', ref: '0', attempt: 2, marker: '[LCW retry]', phase: 'acknowledged', remoteRef: 'remote-2',
    })];
    await h.engine.onAlarm(resumeAlarm(job.id));
    let recovered = await h.store.getJob(job.id);
    expect(recovered?.current?.attempt).toBe(2);
    expect(recovered?.current?.phase).toBe('acknowledged');
    expect(h.provider.sentPrompts).toHaveLength(2);
    await h.engine.onAlarm(resumeAlarm(job.id));
    recovered = await h.store.getJob(job.id);
    expect(recovered?.status).toBe('completed');
  });

  it('对话长度上限要求新会话时遵守最大尝试次数，不无限重发', async () => {
    h.config = { ...h.config, maxAttempts: 1 };
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [{
      status: 'retry_current',
      remoteRef: 'remote-1',
      detail: '达到对话长度上限，请开启新对话',
    }];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    const failed = await h.store.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toContain('达到对话长度上限');
    expect(h.provider.sentPrompts).toHaveLength(1);
  });

  it('大分块遇到上下文上限时自动拆分原文，后续分块结果继续进入归并流程', async () => {
    const job = await makeJob(h, ['段落。'.repeat(30_000)]);
    h.provider.inspectionQueue = [{
      status: 'retry_current',
      strategy: 'split_input',
      remoteRef: 'remote-1',
      detail: '达到对话长度上限，请开启新对话',
    }];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    const metas = await h.store.chunkMetasByJob(job.id);
    expect(metas.length).toBeGreaterThan(1);
    expect(metas.every((meta) => meta.status === 'pending' || meta.status === 'sent')).toBe(true);
    expect((await h.store.getJob(job.id))?.eventLog?.some((event) => event.kind === 'context-split')).toBe(true);
    expect((await h.store.getJob(job.id))?.totalChunks).toBe(metas.length);
    expect((await runToEnd(h, job.id)).status).toBe('completed');
  });

  it('连续拆分小于 64k 的原文保留所有字符和顺序，请求标识不重复', async () => {
    h.config = { ...h.config, maxAttempts: 1, taskKind: 'custom' };
    const text = '  开头\n' + '原文🙂\n'.repeat(4_000) + '结尾  ';
    const job = await makeJob(h, [text, '第二块']);
    const limit = { status: 'retry_current' as const, strategy: 'split_input' as const, detail: '上下文超限' };
    h.provider.inspectionQueue = [limit, limit];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    await h.engine.onAlarm(resumeAlarm(job.id));
    const metas = (await h.store.chunkMetasByJob(job.id)).sort(h.store.compareChunkOrder);
    const bodies = await Promise.all(metas.map((meta) => h.store.getChunkTextById(meta.id)));
    expect(bodies.join('')).toBe(text + '第二块');
    expect((await h.store.getJob(job.id))?.totalChunks).toBe(4);
    expect(metas.map((meta) => meta.index)).toEqual([0, 3, 2, 1]);
    const dispatched = h.provider.prepared.filter((unit) => unit.phase === 'prepared');
    expect(new Set(dispatched.map((unit) => unit.marker)).size).toBe(dispatched.length);
    expect((await runToEnd(h, job.id)).status).toBe('completed');
    const firstReduce = (await h.store.resultsByJob(job.id)).find((result) => result.kind === 'reduce' && result.ref === '1-0');
    const sources = await Promise.all(firstReduce!.sourceIds.map((id) => h.store.getResult(id)));
    expect(sources.map((result) => result?.ref)).toEqual(['0', '3', '2']);
  });

  it('拆分事务后重启，旧 marker 重复调用不再拆分或覆盖分块', async () => {
    const job = await makeJob(h, ['x'.repeat(4_000)]);
    await h.engine.startJob(job.id);
    const oldMarker = (await h.store.getJob(job.id))!.current!.marker;
    const next = await h.store.splitChunkForContextLimit(job.id, oldMarker, ['x'.repeat(2_000), 'x'.repeat(2_000)], '超限');
    expect(next?.current).toBeNull();
    expect(next?.totalChunks).toBe(2);
    expect(await h.store.splitChunkForContextLimit(job.id, oldMarker, ['bad', 'bad'], '超限')).toBeUndefined();
    expect(await h.store.getChunkTextById(`${job.id}:1`)).toBe('x'.repeat(2_000));
    // 新 Engine 没有任何内存状态，必须只根据持久化任务恢复。
    const { Engine } = await import('../src/core/engine/engine');
    h.engine = new Engine({
      connect: async () => CONNECTION_ID,
      prepare: async (_connection, unit) => h.provider.prepare(unit),
      submit: async (_connection, _marker, prompt) => h.provider.submit(prompt),
      inspect: async (_connection, unit) => h.provider.inspect(unit),
      scheduleAlarm: (name, when) => void h.alarms.set(name, when),
      clearAlarm: (name) => void h.alarms.delete(name), log: () => undefined,
    });
    await h.engine.resumeActive();
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.current?.marker).not.toBe(oldMarker);
    expect((await runToEnd(h, job.id)).status).toBe('completed');
  });

  it('索引和提炼超限后重新索引新原文，完整经过格式统一与归并', async () => {
    h.config = { ...h.config, pipelineMode: 'staged' };
    const job = await makeJob(h, ['原文\n'.repeat(8_000)]);
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id)); // 前置规范 -> index
    h.provider.inspectionQueue = [{ status: 'retry_current', strategy: 'split_input', detail: '索引超限' }];
    await h.engine.onAlarm(resumeAlarm(job.id));
    while ((await h.store.getJob(job.id))?.current?.kind === 'index') await h.engine.onAlarm(resumeAlarm(job.id));
    const before = (await h.store.getJob(job.id))!;
    expect(before.current?.kind).toBe('extract');
    const oldIndexId = (await h.store.getChunkMeta(job.id, 0))!.indexResultId;
    h.provider.inspectionQueue = [{ status: 'retry_current', strategy: 'split_input', detail: '提炼超限' }];
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.current?.kind).toBe('index');
    expect((await h.store.getChunkMeta(job.id, 0))?.indexResultId).toBeNull();
    expect(await h.store.getResult(oldIndexId!)).toBeDefined();
    const done = await runToEnd(h, job.id);
    expect(done.status).toBe('completed');
    expect(done.totalChunks).toBe(3);
    expect(h.provider.prepared.some((unit) => unit.kind === 'normalize')).toBe(true);
  });

  it('归并超限后分组且后续层沿用预算，无法收敛时有界结束', async () => {
    h.config = { ...h.config, taskKind: 'custom' };
    const job = await makeJob(h, ['a', 'b', 'c']);
    await h.engine.startJob(job.id);
    for (let i = 0; i < 3; i++) await h.engine.onAlarm(resumeAlarm(job.id));
    const original = (await h.store.getJob(job.id))!.current!;
    expect(original.kind).toBe('reduce');
    h.provider.inspectionQueue = [{ status: 'retry_current', strategy: 'split_input', detail: '归并超限' }];
    await h.engine.onAlarm(resumeAlarm(job.id));
    const split = (await h.store.getJob(job.id))!;
    expect(split.reduceState?.groups).toHaveLength(2);
    expect(split.current?.marker).not.toBe(original.marker);
    expect(split.contextInputBudget).toBeGreaterThan(0);
    const done = await runToEnd(h, job.id, 15);
    expect(done.status).toBe('failed');
    expect(done.lastError).toContain('无法继续收敛');
  });

  it('格式统一拆分保留已完成结果，并移动后续复用组的编号', async () => {
    const job = await makeJob(h, ['a', 'b', 'c', 'd']);
    await h.engine.startJob(job.id);
    for (let i = 0; i < 5; i++) await h.engine.onAlarm(resumeAlarm(job.id));
    const normalizing = (await h.store.getJob(job.id))!;
    expect(normalizing.current?.kind).toBe('normalize');
    const inputIds = normalizing.formatState!.inputIds;
    await h.store.saveJob({ ...normalizing, formatState: { ...normalizing.formatState!,
      groups: [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }],
      nextGroup: 1, outputIds: [inputIds[0]!], reusedOutputIds: { 2: inputIds[3]! },
    }, current: { ...normalizing.current!, ref: 'batch-1' } });
    h.provider.inspectionQueue = [{ status: 'retry_current', strategy: 'split_input', detail: '格式统一超限' }];
    await h.engine.onAlarm(resumeAlarm(job.id));
    const split = (await h.store.getJob(job.id))!;
    expect(split.formatState?.outputIds).toEqual([inputIds[0]]);
    expect(split.formatState?.reusedOutputIds).toEqual({ 3: inputIds[3] });
    expect(split.formatState?.groups).toHaveLength(4);
    expect(split.current?.attempt).toBe(2);
    await runToEnd(h, job.id);
    const results = await h.store.resultsByJob(job.id);
    expect(results.filter((result) => result.kind === 'normalize').map((result) => result.ref)).toEqual(['batch-1', 'batch-2']);
  });

  it('Provider 检测到回复尾部重复时不继续生成，而是新会话重试当前单元', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    h.provider.inspectionQueue = [{
      status: 'retry_current',
      remoteRef: 'remote-1',
      detail: '检测到回复尾部连续重复，停止继续生成并重新创建会话重试',
    }];
    await h.engine.onAlarm(resumeAlarm(job.id));
    const retried = await h.store.getJob(job.id);
    expect(retried?.current?.attempt).toBe(2);
    expect(retried?.current?.phase).toBe('acknowledged');
    expect(h.provider.sentPrompts).toHaveLength(2);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('失败分块重试成功后会继续归并并完成任务', async () => {
    h.config = { ...h.config, maxAttempts: 2 };
    const job = await makeJob(h, ['only']);
    h.provider.inspectionQueue = [
      { status: 'complete', remoteRef: 'remote-1', reply: '{"knowledge":' },
      { status: 'complete', remoteRef: 'remote-2', reply: '仍然不是 JSON' },
    ];
    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('failed');

    h.provider.inspectionQueue = [{
      status: 'complete',
      remoteRef: 'remote-retry',
      reply: '```json\n{"knowledge":[{"category":"事实","topic":"重试成功","content":"重试成功"}]}\n```',
    }];
    await h.engine.retryFailed(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    const done = await h.store.getJob(job.id);
    expect(done?.status).toBe('completed');
    expect(done?.failedChunks).toEqual([]);
  });

  it('暂停状态下重试失败分块会重新排队，但不会擅自恢复任务', async () => {
    const job = await makeJob(h, ['failed chunk', 'current chunk']);
    await h.store.saveChunkMeta({
      ...(await h.store.getChunkMeta(job.id, 0))!,
      status: 'failed',
      attempts: 3,
      error: '旧版结构校验失败',
    });
    const current = {
      kind: 'extract' as const,
      ref: '1',
      attempt: 1,
      marker: `[LCW job=${job.shortId} kind=extract ref=1 attempt=1]`,
      phase: 'acknowledged' as const,
      remoteRef: 'remote-current',
    };
    await h.store.saveJob({
      ...job,
      status: 'paused',
      prevStatus: 'waiting',
      current,
      failedChunks: [0],
      lastError: '旧版结构校验失败',
    });

    await h.engine.retryFailed(job.id);

    const queued = await h.store.getJob(job.id);
    expect(queued?.status).toBe('paused');
    expect(queued?.current).toEqual(current);
    expect(queued?.failedChunks).toEqual([]);
    expect(queued?.lastError).toBeNull();
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('pending');
  });

  it('暂停且有当前单元时也可以单独重新排队失败分块', async () => {
    const job = await makeJob(h, ['failed chunk', 'current chunk']);
    const failedMeta = (await h.store.getChunkMeta(job.id, 0))!;
    await h.store.saveChunkMeta({ ...failedMeta, status: 'failed', attempts: 3, error: '旧错误' });
    await h.store.saveJob({
      ...job,
      status: 'paused',
      prevStatus: 'waiting',
      current: {
        kind: 'extract', ref: '1', attempt: 1,
        marker: `[LCW job=${job.shortId} kind=extract ref=1 attempt=1]`,
        phase: 'acknowledged', remoteRef: 'remote-current',
      },
      failedChunks: [0],
    });

    await h.engine.retryChunk(job.id, 0);

    const queued = await h.store.getJob(job.id);
    expect(queued?.status).toBe('paused');
    expect(queued?.current?.ref).toBe('1');
    expect(queued?.failedChunks).toEqual([]);
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('pending');
  });

  it('格式规范使用结构化提取结果，并保留原始回复记录', async () => {
    h.config = { ...h.config, fanIn: 2 };
    const job = await makeJob(h, ['first', 'second']);
    h.provider.inspectionQueue = [
      {
        status: 'complete',
        remoteRef: 'remote-1',
        reply: '原始附加说明一\n```json\n{"knowledge":[{"category":"事实","topic":"事实一","content":"事实一","details":{"sourceDetail":"必须保留一"}}]}\n```',
      },
      {
        status: 'complete',
        remoteRef: 'remote-2',
        reply: '原始附加说明二\n```json\n{"knowledge":[{"category":"事实","topic":"事实二","content":"事实二","details":{"sourceDetail":"必须保留二"}}]}\n```',
      },
    ];

    await h.engine.startJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    await h.engine.onAlarm(resumeAlarm(job.id));

    expect(h.provider.sentPrompts).toHaveLength(3);
    const formatPrompt = h.provider.sentPrompts[2]!;
    expect(formatPrompt).toContain('阶段：动态格式规范');
    expect(formatPrompt).toContain('"sourceDetail":"必须保留一"');
    expect(formatPrompt).toContain('"sourceDetail":"必须保留二"');
    const extracted = (await h.store.resultsByJob(job.id)).filter((result) => result.kind === 'extract');
    expect(extracted[0]?.raw).toContain('原始附加说明一');
    expect(extracted[1]?.raw).toContain('原始附加说明二');
  });

  it('prepared claim 在重启后以相同 marker 安全继续提交', async () => {
    const job = await makeJob(h, ['only']);
    const marker = `[LCW job=${job.shortId} kind=extract ref=0 attempt=1]`;
    await h.store.saveJob({
      ...job,
      status: 'waiting',
      current: { kind: 'extract', ref: '0', attempt: 1, marker, phase: 'prepared', remoteRef: null },
    });
    await h.engine.onAlarm(timeoutAlarm(job.id));
    const recovered = await h.store.getJob(job.id);
    expect(recovered?.current?.marker).toBe(marker);
    expect(recovered?.current?.phase).toBe('acknowledged');
    expect(h.provider.sentPrompts).toHaveLength(1);
    expect(h.provider.sentPrompts[0]).toContain(marker);
  });

  it('提交结果不明确时 fail closed，保留 claim 且不自动重复发送', async () => {
    h.provider.submitOutcome = { status: 'ambiguous', detail: '连接在 click 后断开' };
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    let current = await h.store.getJob(job.id);
    expect(current?.status).toBe('failed');
    expect(current?.current?.phase).toBe('submitting');
    expect(h.provider.sentPrompts).toHaveLength(1);

    h.provider.submitOutcome = null;
    h.provider.inspection = { status: 'missing', detail: '无法证明页面是否收到请求' };
    await h.engine.retryFailed(job.id);
    current = await h.store.getJob(job.id);
    expect(current?.status).toBe('failed');
    expect(h.provider.sentPrompts).toHaveLength(1);

    h.provider.inspection = null;
    await h.engine.forceRetryCurrent(job.id);
    expect(h.provider.sentPrompts).toHaveLength(2);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('Provider 明确忙碌时以相同 attempt 安全延迟重试', async () => {
    h.provider.submitOutcome = { status: 'retryable', detail: '仍有消息正在生成', retryAfterMs: 5_000 };
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    let waiting = await h.store.getJob(job.id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.current?.phase).toBe('prepared');
    expect(waiting?.current?.attempt).toBe(1);
    expect(waiting?.stats.sent).toBe(0);

    h.provider.submitOutcome = null;
    await h.engine.onAlarm(resumeAlarm(job.id));
    waiting = await h.store.getJob(job.id);
    expect(waiting?.current?.phase).toBe('acknowledged');
    expect(waiting?.current?.attempt).toBe(1);
    expect(h.provider.sentPrompts).toHaveLength(2);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
  });

  it('重复完成事件通过同一事务幂等，不重复计数或写结果', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    await Promise.all([
      h.engine.onGenerationEnd(CONNECTION_ID),
      h.engine.onGenerationEnd(CONNECTION_ID),
    ]);
    const done = await h.store.getJob(job.id);
    expect(done?.status).toBe('completed');
    expect(done?.stats.collected).toBe(1);
    expect(await h.store.resultsByJob(job.id)).toHaveLength(1);
  });

  it('结果已写入但任务指针未推进时，重新对账会补齐收集并继续任务', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    const current = (await h.store.getJob(job.id))!.current!;
    const stale: ResultRecord = {
      id: `${job.id}:c0:a${current.attempt}`,
      jobId: job.id,
      kind: 'extract',
      level: 0,
      ref: '0',
      sourceIds: [`${job.id}:0`],
      raw: '{"knowledge":[{"category":"事实","topic":"已写入","content":"已写入"}]}',
      parsed: { version: 3, knowledge: [{ category: '事实', topic: '已写入', content: '已写入' }] },
      createdAt: Date.now(),
    };
    await h.store.saveResult(stale);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    const recovered = await h.store.getJob(job.id);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.current).toBeNull();
    expect(recovered?.stats.collected).toBe(1);
  });

  it('多层归并动态收敛', async () => {
    const job = await makeJob(h, Array.from({ length: 10 }, (_, index) => `块${index}`));
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    const results = await h.store.resultsByJob(job.id);
    expect(done.status).toBe('completed');
    expect(results.filter((result) => result.kind === 'format')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'normalize')).toHaveLength(4);
    expect(results.filter((result) => result.kind === 'reduce')).toHaveLength(3);
  });

  it('分块重试耗尽后不生成不完整结果，修复后可恢复', async () => {
    h.provider.inspection = { status: 'complete', reply: '不是 JSON' };
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    for (let attempt = 0; attempt < 3; attempt++) await h.engine.onGenerationEnd(CONNECTION_ID);
    let failed = await h.store.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.failedChunks).toEqual([0]);
    expect(failed?.finalResultId).toBeNull();

    h.provider.inspection = null;
    await h.engine.retryFailed(job.id);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    failed = await h.store.getJob(job.id);
    expect(failed?.status).toBe('completed');
    expect(failed?.lastError).toBeNull();
  });

  it('归并预算导致每组只能容纳一项时明确失败而不是无限递归', async () => {
    h.config = { ...h.config, maxChunkChars: 1 };
    const job = await makeJob(h, ['a', 'b']);
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    expect(done.status).toBe('failed');
    expect(done.lastError).toContain('无法收敛');
  });
});
