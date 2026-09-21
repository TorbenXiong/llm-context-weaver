export interface DeepSeekContinuationResult {
  found: boolean;
  attempted: boolean;
  confirmed: boolean;
  evidence?: 'button_disappeared' | 'button_disabled' | 'generating' | 'reply_grew' | 'not_confirmed';
  detail?: string;
}

export type DeepSeekCommand =
  | { channel: 'deepseek-v5'; type: 'ping' }
  | { channel: 'deepseek-v5'; type: 'newChat' }
  | { channel: 'deepseek-v5'; type: 'setFeatures'; deepThinking: boolean; smartSearch: boolean }
  | { channel: 'deepseek-v5'; type: 'hasMarker'; marker: string }
  | { channel: 'deepseek-v5'; type: 'sendPrompt'; text: string }
  | { channel: 'deepseek-v5'; type: 'readReply'; marker: string; expectJson: boolean }
  | { channel: 'deepseek-v5'; type: 'continueGeneration'; marker: string }
  | { channel: 'deepseek-v5'; type: 'deleteSessions'; sessionRefs: string[] }
  | { channel: 'deepseek-v5'; type: 'status' };

export const isDeepSeekCommand = (message: unknown): message is DeepSeekCommand =>
  !!message && typeof message === 'object' && (message as { channel?: string }).channel === 'deepseek-v5';
