import type { ExtractionResult } from './protocol/schema';

/** 任务级状态机状态，见 engine/stateMachine.ts */
export type JobStatus =
  | 'split'
  | 'processing'
  | 'waiting'
  | 'collecting'
  | 'reducing'
  | 'paused'
  | 'completed'
  | 'canceled'
  | 'failed';

export type UnitKind = 'extract' | 'reduce';
export type ChunkStatus = 'pending' | 'sent' | 'done' | 'failed';
export type DispatchPhase = 'prepared' | 'submitting' | 'acknowledged';

export interface JobConfig {
  /** 分块软上限（字符数），按行边界切分 */
  maxChunkChars: number;
  /** 分块硬上限，单行超长时强制截断 */
  hardMaxChunkChars: number;
  /** 归并扇入：每组最多合并多少条中间结果 */
  fanIn: number;
  /** 相邻两次发送的最小间隔 */
  sendDelayMs: number;
  /** 单次生成超时（超时后走对账流程） */
  generationTimeoutMs: number;
  /** 单个 Chunk / 归并单元的最大尝试次数 */
  maxAttempts: number;
  /** 归并请求的输入总字符预算 */
  reduceMaxInputChars: number;
}

export const DEFAULT_JOB_CONFIG: JobConfig = {
  maxChunkChars: 16_000,
  hardMaxChunkChars: 60_000,
  fanIn: 8,
  sendDelayMs: 1_500,
  generationTimeoutMs: 5 * 60_000,
  maxAttempts: 3,
  reduceMaxInputChars: 48_000,
};

/** 当前在途工作单元。Provider 运行时只能把远端状态作为不透明引用返回给核心。 */
export interface CurrentUnit {
  kind: UnitKind;
  /** extract: chunk 序号；reduce: "level-group" */
  ref: string;
  attempt: number;
  marker: string;
  phase: DispatchPhase;
  /** 命中限流时为 true，重发不消耗 attempt */
  rateLimited?: boolean;
  /** Provider 返回的不透明远端引用（会话 ID、URL 或其他 locator 均由 Adapter 解释） */
  remoteRef?: string | null;
}

export interface ReduceGroup {
  start: number;
  end: number;
}

export interface ReduceState {
  level: number;
  inputIds: string[];
  groups: ReduceGroup[];
  nextGroup: number;
  outputIds: string[];
}

export interface Job {
  id: string;
  shortId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  /** 暂停前的状态，Resume 时恢复 */
  prevStatus: JobStatus | null;
  config: JobConfig;
  providerId: string;
  /** Provider 连接的不透明标识；核心不得解析其内容。 */
  providerConnectionId: string | null;
  current: CurrentUnit | null;
  reduceState: ReduceState | null;
  totalChunks: number;
  failedChunks: number[];
  finalResultId: string | null;
  lastError: string | null;
  stats: { sent: number; collected: number; rateLimitHits: number };
}

/** 元数据与正文分开存：调度只读小表，发送时才取正文，避免把 50MB 全量载入内存 */
export interface ChunkMeta {
  id: string;
  jobId: string;
  index: number;
  status: ChunkStatus;
  attempts: number;
  resultId: string | null;
  error: string | null;
}

export interface ChunkText {
  id: string;
  text: string;
}

export interface ResultRecord {
  /** `${jobId}:c{index}:a{attempt}` 或 `${jobId}:r{level}g{group}:a{attempt}`，同 id 覆盖写保证幂等 */
  id: string;
  jobId: string;
  kind: UnitKind;
  level: number;
  ref: string;
  sourceIds: string[];
  raw: string;
  parsed: ExtractionResult;
  createdAt: number;
}

export interface JobProgress {
  total: number;
  pending: number;
  sent: number;
  done: number;
  failed: number;
}
