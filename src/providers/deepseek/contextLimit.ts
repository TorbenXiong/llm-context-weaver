/** 页面达到会话上下文上限时，必须换新会话重试当前单元。 */
export function isDeepSeekConversationLimitText(text: string | null | undefined): boolean {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized || normalized.length > 500) return false;
  return /^(?:达到对话长度上限|对话长度已达上限|请开启新对话(?:$|[。.!！]|后)|开启新对话后继续|conversation length limit|context length exceeded|conversation is too long|start a new chat)/.test(normalized);
}
