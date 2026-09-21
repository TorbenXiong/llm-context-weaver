import type { ReduceGroup } from '../types';

export interface ReducePlanOptions {
  /** 每组最多多少条输入 */
  fanIn: number;
  /** 每组输入总字符预算 */
  maxChars: number;
}

/**
 * 归并分组规划（纯函数）：按 fanIn 与字符预算贪心分组。
 * 层数不做硬编码，由引擎循环调用直到收敛为一条结果；
 * 单条输入超预算时独占一组（请求可能失败，由重试/失败落账兜底）。
 */
export function planGroups(sizes: number[], opts: ReducePlanOptions): ReduceGroup[] {
  if (opts.fanIn < 2) throw new Error('fanIn must be >= 2');
  if (opts.maxChars <= 0) throw new Error('maxChars must be > 0');
  const groups: ReduceGroup[] = [];
  let start = 0;
  let count = 0;
  let size = 0;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i] ?? 0;
    if (count > 0 && (count >= opts.fanIn || size + s > opts.maxChars)) {
      groups.push({ start, end: i });
      start = i;
      count = 0;
      size = 0;
    }
    count++;
    size += s;
  }
  if (count > 0) groups.push({ start, end: sizes.length });
  return groups;
}