export interface DeepSeekContinuationResult {
  found: boolean;
  attempted: boolean;
  confirmed: boolean;
  evidence?: 'button_disappeared' | 'button_disabled' | 'generating' | 'reply_grew' | 'not_confirmed' | 'repeated_tail';
  detail?: string;
}

export const DEEPSEEK_CHANNEL = 'deepseek-v8';

export type DeepSeekCommand = { channel: typeof DEEPSEEK_CHANNEL } & (
  | { type: 'ping' }
  | { type: 'newChat' }
  | { type: 'setFeatures'; deepThinking: boolean; smartSearch: boolean }
  | { type: 'hasMarker'; marker: string }
  | { type: 'sendPrompt'; text: string }
  | { type: 'readReply'; marker: string; expectJson: boolean }
  | { type: 'continueGeneration'; marker: string }
  | { type: 'deleteSessions'; sessionRefs: string[] }
  | { type: 'accountKey' }
  | { type: 'status' });

export const isDeepSeekCommand = (message: unknown): message is DeepSeekCommand =>
  !!message && typeof message === 'object' && (message as { channel?: string }).channel === DEEPSEEK_CHANNEL;
