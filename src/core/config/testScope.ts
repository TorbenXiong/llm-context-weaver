import type { TestScope } from '../types';

export interface TestScopeConfig {
  testScope: TestScope;
  testPercent: number;
  testSessionLimit: number;
}

export function normalizeTestScope(config: Partial<TestScopeConfig>): TestScopeConfig {
  const testScope = config.testScope === 'percent' || config.testScope === 'sessions'
    ? config.testScope
    : 'all';
  const percent = Number(config.testPercent);
  const sessions = Number(config.testSessionLimit);
  return {
    testScope,
    testPercent: Number.isFinite(percent) ? Math.max(1, Math.min(100, Math.floor(percent))) : 100,
    testSessionLimit: Number.isFinite(sessions) && sessions > 0
      ? Math.max(1, Math.min(100_000, Math.floor(sessions)))
      : 0,
  };
}

/** 选择输入前部作为测试样本；归并发生在导入完成后，不受这里限制。 */
export function selectTestChunks(chunks: string[], config: TestScopeConfig): string[] {
  if (config.testScope === 'sessions') return chunks.slice(0, config.testSessionLimit);
  if (config.testScope !== 'percent') return chunks;

  const targetChars = Math.max(1, Math.ceil(
    chunks.reduce((total, chunk) => total + chunk.length, 0) * config.testPercent / 100,
  ));
  const selected: string[] = [];
  let selectedChars = 0;
  for (const chunk of chunks) {
    selected.push(chunk);
    selectedChars += chunk.length;
    if (selectedChars >= targetChars) break;
  }
  return selected;
}

export function fileTestByteLimit(fileSize: number, config: TestScopeConfig): number {
  return config.testScope === 'percent'
    ? Math.max(1, Math.ceil(fileSize * config.testPercent / 100))
    : Number.POSITIVE_INFINITY;
}

export function reachedFileTestLimit(
  selectedBytes: number,
  selectedChunks: number,
  config: TestScopeConfig,
  byteLimit: number,
): boolean {
  if (config.testScope === 'percent') return selectedBytes >= byteLimit;
  return config.testScope === 'sessions' && selectedChunks >= config.testSessionLimit;
}
