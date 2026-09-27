import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_PROACTIVE_MAX_TRAFFIC_CHARS,
  DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS,
  DEEPSEEK_MIN_DISPATCH_INTERVAL_MS,
  DEEPSEEK_CONTINUATION_PROBE_MS,
  DEEPSEEK_PROACTIVE_MIN_LEARNABLE_CHARS,
  DEEPSEEK_PROACTIVE_SAFETY_RATIO,
  DEEPSEEK_PROACTIVE_WINDOW_MS,
  DEEPSEEK_RATE_LIMIT_RETRY_MS,
  getDeepSeekDispatchCooldown,
} from '../src/providers/deepseek/policy';
import { RATE_LIMIT_PATTERNS } from '../src/providers/deepseek/selectors';

describe('DeepSeek provider policy', () => {
  it('明确限流后退避 65 分钟', () => {
    expect(DEEPSEEK_RATE_LIMIT_RETRY_MS).toBe(65 * 60_000);
    expect(DEEPSEEK_CONTINUATION_PROBE_MS).toBe(35 * 60_000);
  });

  it('不会把普通的生成中提示误判成限流', () => {
    const limited = (text: string) => RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
    expect(limited('消息发送过于频繁，请稍后重试')).toBe(true);
    expect(limited('有消息正在生成，请稍后再试')).toBe(false);
  });

  it('没有限流历史时，低于默认预算不主动冷却', () => {
    const now = 1_000_000;
    const history = [
      { marker: 'a', submittedAt: now - 10 * 60_000, inputChars: 140_000, outputChars: 60_000 },
      { marker: 'b', submittedAt: now - 5 * 60_000, inputChars: 80_000, outputChars: 30_000 },
    ];
    const advice = getDeepSeekDispatchCooldown({ trafficHistory: history, rateLimitEvents: [] }, 10_000, now);
    expect(advice).toBeNull();
  });

  it('输入输出量低于预算时不额外等待', () => {
    const now = 1_000_000;
    const advice = getDeepSeekDispatchCooldown({
      trafficHistory: [{ marker: 'a', submittedAt: now - DEEPSEEK_MIN_DISPATCH_INTERVAL_MS - 1, inputChars: DEEPSEEK_PROACTIVE_MAX_TRAFFIC_CHARS - 1, outputChars: 0 }],
      rateLimitEvents: [],
    }, 0, now);
    expect(advice).toBeNull();
    expect(DEEPSEEK_PROACTIVE_WINDOW_MS).toBe(60 * 60_000);
  });

  it('达到默认预算后等待最早一批流量离开一小时窗口', () => {
    const now = 1_000_000;
    const firstAt = now - 10_000;
    const advice = getDeepSeekDispatchCooldown({
      trafficHistory: [{ marker: 'a', submittedAt: firstAt, inputChars: DEEPSEEK_PROACTIVE_MAX_TRAFFIC_CHARS - 100, outputChars: 0 }],
      rateLimitEvents: [],
    }, 101, now);
    expect(advice?.until).toBe(firstAt + DEEPSEEK_PROACTIVE_WINDOW_MS);
    expect(advice?.detail).toContain('近 1 小时');
  });

  it('忽略官方限流后的残留小样本，并按可信限流样本留出 10% 余量', () => {
    const now = 1_000_000;
    const observed = 11_506_359;
    const advice = getDeepSeekDispatchCooldown({
      trafficHistory: [{ marker: 'a', submittedAt: now - 1_000, inputChars: Math.floor(observed * DEEPSEEK_PROACTIVE_SAFETY_RATIO) - 1, outputChars: 0 }],
      rateLimitEvents: [{
        occurredAt: now - 2 * 60 * 60_000,
        sentCount: 1,
        providerSessionCount: 1,
        inputChars: 512_774,
        outputChars: 0,
        intervalInputChars: 512_774,
        intervalOutputChars: 0,
        retryAfterMs: DEEPSEEK_RATE_LIMIT_RETRY_MS,
      }, {
        occurredAt: now - 60 * 60_000,
        sentCount: 2,
        providerSessionCount: 2,
        inputChars: 11_506_359,
        outputChars: 289_730,
        intervalInputChars: 11_506_359,
        intervalOutputChars: 289_730,
        retryAfterMs: DEEPSEEK_RATE_LIMIT_RETRY_MS,
      }],
    }, 10_000, now);
    expect(observed).toBeGreaterThan(DEEPSEEK_PROACTIVE_MIN_LEARNABLE_CHARS);
    expect(advice).toBeTruthy();
    expect(advice?.detail).toContain('8,629,769');
  });

  it('输出量达到 22 万字符时主动冷却，即使输入量尚未达到预算', () => {
    const now = 1_000_000;
    const firstAt = now - 10_000;
    const advice = getDeepSeekDispatchCooldown({
      trafficHistory: [{ marker: 'a', submittedAt: firstAt, inputChars: 100_000, outputChars: DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS }],
      rateLimitEvents: [],
    }, 0, now);
    expect(advice?.until).toBe(firstAt + DEEPSEEK_PROACTIVE_WINDOW_MS);
    expect(advice?.detail).toContain('输出量达到 220,000');
  });

  it('长回复按完成时间计入输出预算，不能因提交较早而漏掉主动限流', () => {
    const now = 1_000_000;
    const advice = getDeepSeekDispatchCooldown({
      trafficHistory: [{
        marker: 'long-reply',
        submittedAt: now - DEEPSEEK_PROACTIVE_WINDOW_MS - 1_000,
        completedAt: now - 1_000,
        inputChars: 100_000,
        outputChars: DEEPSEEK_PROACTIVE_MAX_OUTPUT_CHARS,
      }],
      rateLimitEvents: [],
    }, 0, now);
    expect(advice).toBeTruthy();
    expect(advice?.detail).toContain('输出量达到 220,000');
  });

  it('连续发送间隔不足时先主动等待', () => {
    const now = 1_000_000;
    const advice = getDeepSeekDispatchCooldown({
      trafficHistory: [{ marker: 'a', submittedAt: now - 1_000, inputChars: 100, outputChars: 100 }],
      rateLimitEvents: [],
    }, 100, now);
    expect(advice?.until).toBe(now - 1_000 + DEEPSEEK_MIN_DISPATCH_INTERVAL_MS);
    expect(advice?.detail).toContain('连续发送间隔不足');
  });
});
