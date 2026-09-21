import { describe, expect, it } from 'vitest';
import { DEEPSEEK_RATE_LIMIT_RETRY_MS } from '../src/providers/deepseek/policy';
import { RATE_LIMIT_PATTERNS } from '../src/providers/deepseek/selectors';

describe('DeepSeek provider policy', () => {
  it('明确限流后退避 30 分钟', () => {
    expect(DEEPSEEK_RATE_LIMIT_RETRY_MS).toBe(30 * 60_000);
  });

  it('不会把普通的生成中提示误判成限流', () => {
    const limited = (text: string) => RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
    expect(limited('消息发送过于频繁，请稍后重试')).toBe(true);
    expect(limited('有消息正在生成，请稍后再试')).toBe(false);
  });
});
