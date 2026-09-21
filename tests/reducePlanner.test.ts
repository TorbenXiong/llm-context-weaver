import { describe, expect, it } from 'vitest';
import { planGroups } from '../src/core/reduce/reducePlanner';

describe('planGroups', () => {
  it('按 fanIn 分组', () => {
    expect(planGroups([10, 10, 10, 10, 10], { fanIn: 2, maxChars: 1000 })).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 5 },
    ]);
  });

  it('按字符预算拆组', () => {
    expect(planGroups([100, 100, 100], { fanIn: 8, maxChars: 150 })).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  it('单条超预算时独占一组', () => {
    expect(planGroups([500, 10], { fanIn: 8, maxChars: 100 })).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it('空输入返回空，参数非法抛错', () => {
    expect(planGroups([], { fanIn: 8, maxChars: 100 })).toEqual([]);
    expect(() => planGroups([1], { fanIn: 1, maxChars: 100 })).toThrow();
  });
});