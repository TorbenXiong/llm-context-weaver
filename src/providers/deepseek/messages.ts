export type DeepSeekCommand =
  | { channel: 'deepseek'; type: 'ping' }
  | { channel: 'deepseek'; type: 'newChat' }
  | { channel: 'deepseek'; type: 'hasMarker'; marker: string }
  | { channel: 'deepseek'; type: 'sendPrompt'; text: string }
  | { channel: 'deepseek'; type: 'readReply'; marker: string }
  | { channel: 'deepseek'; type: 'status' };

export const isDeepSeekCommand = (message: unknown): message is DeepSeekCommand =>
  !!message && typeof message === 'object' && (message as { channel?: string }).channel === 'deepseek';
