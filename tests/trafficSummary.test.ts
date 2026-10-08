import { describe, expect, it } from 'vitest';
import { summarizeTraffic } from '../src/ui/trafficSummary';

describe('工作台账号流量摘要', () => {
  it('切换账号后本轮从零开始，任务累计保留其他账号流量且不重复计数', () => {
    const summary = summarizeTraffic({
      providerAccountKey: 'b',
      providerAccountChangedAt: 200,
      trafficHistory: [
        { marker: 'a', accountKey: 'a', submittedAt: 100, inputChars: 1000, outputChars: 1000 },
        { marker: 'b', accountKey: 'b', submittedAt: 250, inputChars: 20, outputChars: 3 },
      ],
      rateLimitEvents: [{ accountKey: 'a', occurredAt: 150, sentCount: 1, providerSessionCount: 1,
        inputChars: 1000, outputChars: 1000, cumulativeInputChars: 1000, cumulativeOutputChars: 1000, retryAfterMs: 1 }],
    });
    expect(summary.inputChars).toBe(20);
    expect(summary.outputChars).toBe(3);
    expect(summary.cumulativeInputChars).toBe(1020);
    expect(summary.cumulativeOutputChars).toBe(1003);
  });

  it('切回旧账号后本轮不恢复旧流量，延迟收集的旧请求输出也不计入本轮', () => {
    const summary = summarizeTraffic({ providerAccountKey: 'a', providerAccountChangedAt: 300,
      trafficHistory: [
        { marker: 'old', accountKey: 'a', submittedAt: 100, inputChars: 100, outputChars: 50, completedAt: 320 },
        { marker: 'other', accountKey: 'b', submittedAt: 200, inputChars: 200, outputChars: 20, completedAt: 250 },
      ], rateLimitEvents: [] });
    expect(summary).toEqual({ inputChars: 0, outputChars: 0, cumulativeInputChars: 300, cumulativeOutputChars: 70 });
  });

  it('输入和输出按各自时间跨过限流边界，累计包含未确认的限流请求', () => {
    const summary = summarizeTraffic({ providerAccountKey: 'a', trafficHistory: [
      { marker: 'old', accountKey: 'a', submittedAt: 100, inputChars: 100, outputChars: 50, completedAt: 220 },
      { marker: 'new', accountKey: 'a', submittedAt: 230, inputChars: 20, outputChars: 3, completedAt: 250 },
    ], rateLimitEvents: [{ accountKey: 'a', occurredAt: 200, sentCount: 1, providerSessionCount: 1,
      inputChars: 110, outputChars: 0, cumulativeInputChars: 110, cumulativeOutputChars: 0, retryAfterMs: 1 }] });
    expect(summary).toEqual({ inputChars: 20, outputChars: 53, cumulativeInputChars: 130, cumulativeOutputChars: 53 });
  });
});
