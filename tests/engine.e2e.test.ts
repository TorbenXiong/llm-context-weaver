import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, EngineHost } from '../src/core/engine/engine';
import type { ProviderInspection, ProviderSubmitOutcome } from '../src/core/provider';
import type * as JobStore from '../src/core/storage/jobStore';
import { DEFAULT_JOB_CONFIG, type CurrentUnit, type Job, type JobConfig } from '../src/core/types';

const CONNECTION_ID = 'fake-connection';
const timeoutAlarm = (jobId: string): string => `lcw:t:${jobId}`;
const resumeAlarm = (jobId: string): string => `lcw:r:${jobId}`;

class FakeProvider {
  sentPrompts: string[] = [];
  newSessions = 0;
  submitOutcome: ProviderSubmitOutcome | null = null;
  inspection: ProviderInspection | null = null;
  inspectionQueue: ProviderInspection[] = [];
  prepared: CurrentUnit[] = [];
  cleanupCalls: string[][] = [];

  prepare(unit: CurrentUnit): void {
    this.prepared.push(unit);
    if (unit.phase === 'prepared') this.newSessions++;
  }

  submit(prompt: string): ProviderSubmitOutcome {
    this.sentPrompts.push(prompt);
    return this.submitOutcome ?? { status: 'accepted', remoteRef: `remote-${this.sentPrompts.length}` };
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
    connect: async () => CONNECTION_ID,
    prepare: async (_connectionId, unit) => provider.prepare(unit),
    submit: async (_connectionId, _marker, prompt) => provider.submit(prompt),
    inspect: async (_connectionId, unit) => provider.inspect(unit),
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
    formatNormalization: false,
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
  it('知识结果先抽样生成动态格式规范，再分批统一并最终归档', async () => {
    h.config = { ...h.config, formatNormalization: true };
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
    h.config = { ...h.config, formatNormalization: true };
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
    expect(results.filter((result) => result.kind === 'reduce')).toHaveLength(1);
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

  it('3 块提取 + 1 次归并后完成，核心只保存不透明 Provider 引用', async () => {
    const job = await makeJob(h, ['一', '二', '三']);
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    expect(done.status).toBe('completed');
    expect(done.providerId).toBe('fake');
    expect(done.providerConnectionId).toBe(CONNECTION_ID);
    expect(done.stats).toMatchObject({ sent: 4, collected: 4 });
    expect(h.provider.newSessions).toBe(4);
    expect((await h.store.resultsByJob(job.id))).toHaveLength(4);
    expect(done.providerSessionRefs).toHaveLength(4);
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

  it('Provider 限流后等待其建议的 30 分钟再以相同 attempt 重试', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    const limitedAt = Date.now();
    await h.engine.onRateLimited(CONNECTION_ID, 'DeepSeek 消息发送过于频繁', 30 * 60_000);
    const waiting = await h.store.getJob(job.id);
    expect(waiting?.current?.rateLimited).toBe(true);
    expect(waiting?.stats.rateLimitHits).toBe(1);
    expect(h.alarms.has(timeoutAlarm(job.id))).toBe(false);
    expect(h.alarms.get(resumeAlarm(job.id))!).toBeGreaterThanOrEqual(limitedAt + 30 * 60_000);

    await h.engine.onRateLimited(CONNECTION_ID, '重复限流事件', 30 * 60_000);
    expect((await h.store.getJob(job.id))?.stats.rateLimitHits).toBe(1);

    const stillLimited = await h.store.getJob(job.id);
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect((await h.store.getJob(job.id))?.current?.rateLimited).toBe(true);
    expect(h.provider.sentPrompts).toHaveLength(1);

    await h.store.saveJob({
      ...stillLimited!,
      current: { ...stillLimited!.current!, retryAfterAt: Date.now() - 1 },
    });
    await h.engine.onAlarm(resumeAlarm(job.id));
    const retried = await h.store.getJob(job.id);
    expect(retried?.current?.attempt).toBe(1);
    expect(retried?.current?.rateLimited).not.toBe(true);
    expect(h.provider.sentPrompts).toHaveLength(2);
  });

  it('每 100 个 Provider 会话后主动冷却 10 分钟，再发送下一个会话', async () => {
    const job = await makeJob(h, ['only']);
    const refs = Array.from({ length: 100 }, (_, index) => `remote-${index}`);
    await h.store.saveJob({ ...job, providerSessionRefs: refs });
    await h.engine.startJob(job.id);
    const cooling = await h.store.getJob(job.id);
    expect(cooling?.sessionCooldownUntil).toBeTypeOf('number');
    expect(h.provider.sentPrompts).toHaveLength(0);
    expect(h.alarms.get(resumeAlarm(job.id))!).toBeGreaterThanOrEqual(Date.now() + 9 * 60_000);

    await h.engine.onAlarm(resumeAlarm(job.id));
    expect(h.provider.sentPrompts).toHaveLength(0);

    await h.store.saveJob({ ...cooling!, sessionCooldownUntil: Date.now() - 1 });
    await h.engine.onAlarm(resumeAlarm(job.id));
    expect(h.provider.sentPrompts).toHaveLength(1);
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
    expect(failed?.lastError).toBe('有 1 个分块失败，请重试后再归并');
    expect(failed?.stats).toMatchObject({ sent: 2, collected: 0 });
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('failed');
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

  it('归并使用模型原始回复而不是插件清洗后的 parsed', async () => {
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
    const reducePrompt = h.provider.sentPrompts[2]!;
    expect(reducePrompt).toContain('原始附加说明一');
    expect(reducePrompt).toContain('原始附加说明二');
    expect(reducePrompt).toContain('"sourceDetail":"必须保留一"');
    expect(reducePrompt).toContain('"sourceDetail":"必须保留二"');
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

  it('多层归并动态收敛', async () => {
    const job = await makeJob(h, Array.from({ length: 10 }, (_, index) => `块${index}`));
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    const results = await h.store.resultsByJob(job.id);
    expect(done.status).toBe('completed');
    expect(results.filter((result) => result.kind === 'reduce')).toHaveLength(7);
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
