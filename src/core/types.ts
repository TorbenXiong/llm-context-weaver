import type { ExtractionResult, FormatPlan, IndexResult, JsonResult } from './protocol/schema';

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

export type UnitKind = 'index' | 'extract' | 'format' | 'normalize' | 'reduce';
export type ChunkStatus = 'pending' | 'sent' | 'done' | 'failed';
export type ChunkStage = 'index' | 'process' | 'done';
export type DispatchPhase = 'prepared' | 'submitting' | 'acknowledged';
export type TaskKind = 'knowledge' | 'custom';
export type PipelineMode = 'staged' | 'direct';
export type ResultPayload = ExtractionResult | FormatPlan | IndexResult | JsonResult | string;

/** 各阶段可编辑的提示词模板；{{...}} 占位符由核心在发送前替换。 */
export interface PromptTemplateSet {
  index: string;
  extract: string;
  format: string;
  normalize: string;
  reduce: string;
}

export interface JobConfig {
  /** 多阶段先建立目标相关索引再处理原文；直接模式用于翻译、改写等线性任务。 */
  pipelineMode: PipelineMode;
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
  /** 深度思考提示；具体 Provider 可将其映射到网页开关或请求参数。 */
  deepThinking: boolean;
  /** 智能搜索提示；不支持搜索的 Provider 应安全忽略。 */
  smartSearch: boolean;
  /** 完成后是否自动删除 Provider 网页会话（默认关闭，避免误删）。 */
  deleteProviderSessionsOnComplete: boolean;
  /** 结构化知识提取或自定义文本处理。 */
  taskKind: TaskKind;
  /** 用户定义的核心任务；模板只补充输出契约与分片处理约束。 */
  taskInstruction: string;
  /** 本任务使用的各阶段提示词模板，创建后随任务持久化。 */
  promptTemplates: PromptTemplateSet;
}

export const DEFAULT_JOB_CONFIG: JobConfig = {
  pipelineMode: 'staged',
  maxChunkChars: 16_000,
  hardMaxChunkChars: 512_000,
  fanIn: 8,
  sendDelayMs: 1_500,
  generationTimeoutMs: 5 * 60_000,
  maxAttempts: 3,
  deepThinking: false,
  smartSearch: false,
  deleteProviderSessionsOnComplete: false,
  taskKind: 'knowledge',
  taskInstruction: '',
  promptTemplates: {
    index: '',
    extract: '',
    format: '',
    normalize: '',
    reduce: '',
  },
};

/** 当前在途工作单元。Provider 运行时只能把远端状态作为不透明引用返回给核心。 */
export interface CurrentUnit {
  kind: UnitKind;
  /** extract: chunk 序号；reduce: "level-group" */
  ref: string;
  attempt: number;
  marker: string;
  phase: DispatchPhase;
  /** Adapter 读取回复时据此判断是否必须等待完整 JSON。 */
  outputFormat?: 'knowledge-json' | 'text';
  /** 本工作单元要求的 Provider 能力开关。 */
  deepThinking?: boolean;
  smartSearch?: boolean;
  /** 命中限流时为 true，重发不消耗 attempt */
  rateLimited?: boolean;
  /** 用户确认已在网页端手工继续生成；Provider 只读对账，不再自动点击续写。 */
  manualIntervention?: boolean;
  /** 限流退避截止时间；用于 Service Worker 重启后避免提前重试。 */
  retryAfterAt?: number;
  /** 旧版本字段，仅为恢复旧任务保留；当前不再自动生成检查。 */
  continuationProbeAt?: number;
  /** 深度思考任务首次观察到完整回复的时间；稳定窗口结束后才收集。 */
  completionObservedAt?: number;
  /** Provider 返回的不透明远端引用（会话 ID、URL 或其他 locator 均由 Adapter 解释） */
  remoteRef?: string | null;
  /** 本次待发送提示的字符数，用于 Provider 自己的输入量限流策略。 */
  inputChars?: number;
}

/** 已确认提交的输入量与回复量；核心只做遥测持久化，Provider 决定如何解释。 */
export interface TrafficSample {
  marker: string;
  submittedAt: number;
  inputChars: number;
  outputChars?: number;
  /** 回复完整收集的时间；输出预算按此时间进入 Provider 窗口。 */
  completedAt?: number;
}

/** 任务运行摘要日志；只保存状态和计数，不保存提示词、回复正文或凭据。 */
export interface JobEvent {
  at: number;
  kind: string;
  detail: string;
}

/** 官方限流事件的可审计摘要，不保存提示词或回复正文。 */
export interface RateLimitEvent {
  occurredAt: number;
  sentCount: number;
  providerSessionCount: number;
  /** 本次限流事件之间新增的输入量；inputChars 为兼容旧记录的同义字段。 */
  intervalInputChars?: number;
  /** 本次限流事件之间新增的输出量；outputChars 为兼容旧记录的同义字段。 */
  intervalOutputChars?: number;
  /** 从任务开始、包含历次触发限流请求的累计输入量。 */
  cumulativeInputChars?: number;
  /** 从任务开始、包含历次触发限流请求的累计输出量。 */
  cumulativeOutputChars?: number;
  /** 旧版本字段，读取时按本次事件新增量处理。 */
  inputChars: number;
  outputChars: number;
  retryAfterMs: number;
  detail?: string;
}

export interface ReduceGroup {
  start: number;
  end: number;
}

export interface FormatState {
  phase: 'planning' | 'normalizing';
  inputIds: string[];
  planResultId: string | null;
  groups: ReduceGroup[];
  nextGroup: number;
  outputIds: string[];
  /** 重跑时按组复用未受影响的同阶段结果。 */
  reusedOutputIds?: Record<number, string>;
}

export interface ReduceState {
  level: number;
  inputIds: string[];
  groups: ReduceGroup[];
  nextGroup: number;
  outputIds: string[];
  /** 重跑时按组复用未受影响的同层归并结果。 */
  reusedOutputIds?: Record<number, string>;
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
  /** 任务创建的 Provider 会话引用；内容由 Provider 解释，核心只负责持久化。 */
  providerSessionRefs: string[];
  /** Provider 要求下一次发送不得早于此时间。 */
  sessionCooldownUntil?: number;
  /** 当前冷却开始时间；与 sessionCooldownUntil 属于同一次冷却。 */
  sessionCooldownStartedAt?: number;
  /** 主动冷却原因，便于工作台解释为什么暂停。 */
  sessionCooldownReason?: string;
  /** 最近已确认提交的输入/输出量摘要，Provider 可据此做滚动窗口限流。 */
  trafficHistory?: TrafficSample[];
  /** 最近官方限流事件摘要，供后续任务校准主动节流。 */
  rateLimitEvents?: RateLimitEvent[];
  eventLog?: JobEvent[];
  current: CurrentUnit | null;
  reduceState: ReduceState | null;
  /** 知识归档前的动态格式规范与分批统一状态；旧任务缺失时视为 null。 */
  formatState?: FormatState | null;
  /** 当前生效的动态格式规范结果；后置规范完成后会替换前置规范。 */
  formatPlanResultId?: string | null;
  /** 重跑后的 attempt 下限，避免历史结果 ID 与新会话冲突。 */
  reprocessAttemptBases?: Record<string, number>;
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
  /** 当前分块所处流程阶段；旧任务缺失时由引擎按配置迁移。 */
  stage?: ChunkStage;
  /** 多阶段流程的索引结果；process 阶段会把它与原文一同交给模型。 */
  indexResultId?: string | null;
  resultId: string | null;
  error: string | null;
}

export interface ChunkText {
  id: string;
  text: string;
}

export interface ResultRecord {
  /** `${jobId}:c{index}:a{attempt}`、`${jobId}:n{batch}:a{attempt}` 或 `${jobId}:r{level}g{group}:a{attempt}`，同 id 覆盖写保证幂等 */
  id: string;
  jobId: string;
  kind: UnitKind;
  level: number;
  ref: string;
  sourceIds: string[];
  raw: string;
  parsed: ResultPayload;
  createdAt: number;
}

export interface JobProgress {
  total: number;
  indexed: number;
  pending: number;
  sent: number;
  done: number;
  failed: number;
}
