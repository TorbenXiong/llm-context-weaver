import type { CurrentUnit, Job } from './types';

export type ProviderSubmitOutcome =
  | { status: 'accepted'; remoteRef?: string | null }
  | { status: 'rejected'; detail: string }
  | { status: 'retryable'; detail: string; retryAfterMs: number }
  | { status: 'ambiguous'; detail: string }
  | { status: 'rate_limited'; detail: string; retryAfterMs: number; continuationRetryAfterMs?: number };

export type ProviderInspection =
  | { status: 'generating'; remoteRef?: string | null }
  | { status: 'complete'; reply: string; remoteRef?: string | null }
  | { status: 'missing'; detail: string; remoteRef?: string | null }
  | { status: 'unavailable'; detail: string; retryAfterMs: number; remoteRef?: string | null }
  | { status: 'rate_limited'; detail: string; retryAfterMs: number; continuationRetryAfterMs?: number; remoteRef?: string | null }
  /** Provider 判断当前回复已损坏或远端单元不可继续，核心应创建新会话重发。 */
  | { status: 'retry_current'; detail: string; remoteRef?: string | null };

export interface ProviderCleanupResult {
  deletedRefs: string[];
  missingRefs: string[];
}

export interface ProviderDispatchCooldown {
  /** 不早于此时间再尝试发送。 */
  until: number;
  /** 面向工作台的简短原因；不得包含提示词或回复正文。 */
  detail: string;
}

export type ProviderPrepareOutcome =
  | { status: 'ready' }
  /** Provider 已确认当前远端单元不可继续，核心可以在新会话中递增 attempt 重发。 */
  | { status: 'retry_current'; detail: string };

/**
 * Provider 无关的浏览器边界。连接 ID 与远端引用对核心都不透明；
 * 远端地址、页面结构、连接句柄和限流规则只能出现在具体 Provider 实现中。
 */
export interface ProviderHost {
  connect(job: Job): Promise<string>;
  prepare(connectionId: string, unit: CurrentUnit): Promise<ProviderPrepareOutcome | void>;
  submit(connectionId: string, marker: string, prompt: string): Promise<ProviderSubmitOutcome>;
  inspect(connectionId: string, unit: CurrentUnit): Promise<ProviderInspection>;
  /** Provider 根据自身输入/输出限流规则主动要求延迟下一次发送。 */
  getDispatchCooldown?(
    job: Job,
    inputChars: number,
    now: number,
  ): ProviderDispatchCooldown | null | Promise<ProviderDispatchCooldown | null>;
  /** 删除由本任务创建的 Provider 网页会话；引用内容对核心保持不透明。 */
  cleanupSessions?(connectionId: string, sessionRefs: readonly string[]): Promise<ProviderCleanupResult>;
}
