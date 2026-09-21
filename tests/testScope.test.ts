import { describe, expect, it } from 'vitest';
import { normalizeTestScope, selectTestChunks } from '../src/core/config/testScope';

describe('test scope', () => {
  it('按会话数量选择前 N 个提炼分块', () => {
    const config = normalizeTestScope({ testScope: 'sessions', testSessionLimit: 3 });
    expect(selectTestChunks(['a', 'b', 'c', 'd'], config)).toEqual(['a', 'b', 'c']);
  });

  it('按字符比例选择覆盖目标比例的前部内容', () => {
    const config = normalizeTestScope({ testScope: 'percent', testPercent: 50 });
    expect(selectTestChunks(['aa', 'bbbb', 'cccc'], config)).toEqual(['aa', 'bbbb']);
  });

  it('默认不限制输入', () => {
    const config = normalizeTestScope({});
    expect(selectTestChunks(['a', 'b'], config)).toEqual(['a', 'b']);
  });
});
