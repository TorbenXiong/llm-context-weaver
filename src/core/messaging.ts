/** SW / Content Script / UI 三方消息契约（核心层定义，Provider 无关） */

export type UiCommand =
  | { channel: 'ui'; type: 'start'; jobId: string }
  | { channel: 'ui'; type: 'pause' | 'resume' | 'cancel' | 'retryFailed'; jobId: string }
  | { channel: 'ui'; type: 'forceRetryCurrent'; jobId: string }
  | { channel: 'ui'; type: 'retryChunk'; jobId: string; index: number }
  | { channel: 'ui'; type: 'cleanupSessions'; jobId: string };

export type AdapterEventType =
  | 'ready'
  | 'generationStart'
  | 'generationEnd'
  | 'rateLimited'
  | 'error'
  | 'remoteRefChanged';

export interface AdapterEvent {
  channel: 'adapter';
  type: AdapterEventType;
  detail?: string;
  /** Provider 建议的下一次重试延迟（毫秒），主要用于限流退避。 */
  retryAfterMs?: number;
}

const hasChannel = (m: unknown, channel: string): boolean =>
  !!m && typeof m === 'object' && (m as { channel?: string }).channel === channel;

export const isUiCommand = (m: unknown): m is UiCommand => hasChannel(m, 'ui');
export const isAdapterEvent = (m: unknown): m is AdapterEvent => hasChannel(m, 'adapter');
