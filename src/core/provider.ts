import type { CurrentUnit, Job } from './types';

export type ProviderSubmitOutcome =
  | { status: 'accepted'; remoteRef?: string | null }
  | { status: 'rejected'; detail: string }
  | { status: 'retryable'; detail: string; retryAfterMs: number }
  | { status: 'ambiguous'; detail: string }
  | { status: 'rate_limited'; detail: string; retryAfterMs: number };

export type ProviderInspection =
  | { status: 'generating'; remoteRef?: string | null }
  | { status: 'complete'; reply: string; remoteRef?: string | null }
  | { status: 'missing'; detail: string; remoteRef?: string | null }
  | { status: 'unavailable'; detail: string; retryAfterMs: number; remoteRef?: string | null }
  | { status: 'rate_limited'; detail: string; retryAfterMs: number; remoteRef?: string | null };

export interface ProviderCleanupResult {
  deletedRefs: string[];
  missingRefs: string[];
}

/**
 * Provider 无关的浏览器边界。连接 ID 与远端引用对核心都不透明；
 * 远端地址、页面结构、连接句柄和限流规则只能出现在具体 Provider 实现中。
 */
export interface ProviderHost {
  connect(job: Job): Promise<string>;
  prepare(connectionId: string, unit: CurrentUnit): Promise<void>;
  submit(connectionId: string, marker: string, prompt: string): Promise<ProviderSubmitOutcome>;
  inspect(connectionId: string, unit: CurrentUnit): Promise<ProviderInspection>;
  /** 删除由本任务创建的 Provider 网页会话；引用内容对核心保持不透明。 */
  cleanupSessions?(connectionId: string, sessionRefs: readonly string[]): Promise<ProviderCleanupResult>;
}
