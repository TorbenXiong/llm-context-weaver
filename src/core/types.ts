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
/** 新建任务时可只导入一部分提炼会话，归并阶段不计入该限制。 */
export type TestScope = 'all' | 'percent' | 'sessions';
export type ResultPayload = ExtractionResult | FormatPlan | IndexResult | JsonResult | string;

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
  /** 测试范围：all=全部，percent=按原文比例，sessions=最多提炼会话数。 */
  testScope: TestScope;
  testPercent: number;
  testSessionLimit: number;
  /** 知识任务是否在最终归并前生成动态格式规范并分批统一结果。 */
  formatNormalization: boolean;
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
  testScope: 'all',
  testPercent: 100,
  testSessionLimit: 0,
  formatNormalization: true,
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
  /** 限流退避截止时间；用于 Service Worker 重启后避免提前重试。 */
  retryAfterAt?: number;
  /** 深度思考任务首次观察到完整回复的时间；稳定窗口结束后才收集。 */
  completionObservedAt?: number;
  /** Provider 返回的不透明远端引用（会话 ID、URL 或其他 locator 均由 Adapter 解释） */
  remoteRef?: string | null;
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
  /** 任务创建的 Provider 会话引用；内容由 Provider 解释，核心只负责持久化。 */
  providerSessionRefs: string[];
  /** 每完成一批网页会话后的主动冷却截止时间。 */
  sessionCooldownUntil?: number;
  current: CurrentUnit | null;
  reduceState: ReduceState | null;
  /** 知识归档前的动态格式规范与分批统一状态；旧任务缺失时视为 null。 */
  formatState?: FormatState | null;
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
