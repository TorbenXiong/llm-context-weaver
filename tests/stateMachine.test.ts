import { describe, expect, it } from 'vitest';
import { canTransition, transitionJob } from '../src/core/engine/stateMachine';
import { DEFAULT_JOB_CONFIG, type Job, type JobStatus } from '../src/core/types';

function makeJob(status: JobStatus, prevStatus: JobStatus | null = null): Job {
  return {
    id: 'j1',
    shortId: 'abc12345',
    name: 't',
    createdAt: 0,
    updatedAt: 0,
    status,
    prevStatus,
    config: DEFAULT_JOB_CONFIG,
    providerId: 'fake',
    providerConnectionId: null,
    providerSessionRefs: [],
    current: null,
    reduceState: null,
    totalChunks: 1,
    failedChunks: [],
    finalResultId: null,
    lastError: null,
    stats: { sent: 0, collected: 0, rateLimitHits: 0 },
  };
}

describe('stateMachine', () => {
  it('主流程迁移全部合法', () => {
    let j = makeJob('split');
    j = transitionJob(j, 'processing', 1);
    j = transitionJob(j, 'waiting', 2);
    j = transitionJob(j, 'collecting', 3);
    j = transitionJob(j, 'processing', 4);
    j = transitionJob(j, 'reducing', 5);
    j = transitionJob(j, 'waiting', 6);
    j = transitionJob(j, 'collecting', 7);
    j = transitionJob(j, 'reducing', 8);
    j = transitionJob(j, 'completed', 9);
    expect(j.status).toBe('completed');
  });

  it('拒绝非法跳转', () => {
    expect(() => transitionJob(makeJob('split'), 'completed', 1)).toThrow();
    expect(() => transitionJob(makeJob('waiting'), 'completed', 1)).toThrow();
    expect(() => transitionJob(makeJob('canceled'), 'processing', 1)).toThrow();
    expect(canTransition('canceled', 'processing')).toBe(false);
  });

  it('暂停记录 prevStatus，恢复只能回到原状态', () => {
    let j = transitionJob(makeJob('processing'), 'paused', 1);
    expect(j.prevStatus).toBe('processing');
    expect(() => transitionJob(j, 'reducing', 2)).toThrow();
    j = transitionJob(j, 'processing', 3);
    expect(j.status).toBe('processing');
    expect(j.prevStatus).toBeNull();
  });

  it('暂停态只能恢复或取消', () => {
    const j = transitionJob(makeJob('waiting'), 'paused', 1);
    expect(transitionJob(j, 'canceled', 2).status).toBe('canceled');
    expect(canTransition('paused', 'waiting')).toBe(false); // 静态表不含动态恢复
  });

  it('失败 / 已完成的任务可重新打开补跑', () => {
    expect(transitionJob(makeJob('failed'), 'processing', 1).status).toBe('processing');
    expect(transitionJob(makeJob('completed'), 'processing', 1).status).toBe('processing');
  });
});
