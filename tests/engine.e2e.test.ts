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
  prepared: CurrentUnit[] = [];

  prepare(unit: CurrentUnit): void {
    this.prepared.push(unit);
    if (unit.phase === 'prepared') this.newSessions++;
  }

  submit(prompt: string): ProviderSubmitOutcome {
    this.sentPrompts.push(prompt);
    return this.submitOutcome ?? { status: 'accepted', remoteRef: `remote-${this.sentPrompts.length}` };
  }

  inspect(unit: CurrentUnit): ProviderInspection {
    if (this.inspection) return this.inspection;
    const ref = /ref=([\w.-]+)/.exec(unit.marker)?.[1] ?? 'unknown';
    return {
      status: 'complete',
      remoteRef: unit.remoteRef,
      reply: '```json\n' + JSON.stringify({
        facts: [{ text: `fact:${ref}`, confidence: 'high' }],
        projects: [], decisions: [], solutions: [], preferences: [], timeline: [], todos: [], openQuestions: [],
      }) + '\n```',
    };
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
    scheduleAlarm: (name, when) => void alarms.set(name, when),
    clearAlarm: (name) => void alarms.delete(name),
    log: () => undefined,
  };
  const config = { ...DEFAULT_JOB_CONFIG, sendDelayMs: 0, fanIn: 3 };
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
  });

  it('暂停不推进；恢复后先对账在途 claim', async () => {
    const job = await makeJob(h, ['a', 'b']);
    await h.engine.startJob(job.id);
    await h.engine.pause(job.id);
    await h.engine.onGenerationEnd(CONNECTION_ID);
    expect((await h.store.getJob(job.id))?.status).toBe('paused');
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('sent');
    await h.engine.resume(job.id);
    expect((await h.store.getChunkMeta(job.id, 0))?.status).toBe('done');
    expect((await runToEnd(h, job.id)).status).toBe('completed');
  });

  it('没有 generationEnd 时，alarm 仍可对账收单', async () => {
    const job = await makeJob(h, ['only']);
    await h.engine.startJob(job.id);
    expect(h.alarms.has(timeoutAlarm(job.id))).toBe(true);
    await h.engine.onAlarm(timeoutAlarm(job.id));
    expect((await h.store.getJob(job.id))?.status).toBe('completed');
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
    h.config = { ...h.config, reduceMaxInputChars: 1 };
    const job = await makeJob(h, ['a', 'b']);
    await h.engine.startJob(job.id);
    const done = await runToEnd(h, job.id);
    expect(done.status).toBe('failed');
    expect(done.lastError).toContain('无法收敛');
  });
});
