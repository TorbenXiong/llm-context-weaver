import { describe, expect, it } from 'vitest';
import {
  deriveDeepSeekAccountKey,
  describeDeepSeekAccount,
  extractDeepSeekAccountIdentityText,
  isDeepSeekConversationLimitText,
  normalizeDeepSeekAccountLabel,
  readDeepSeekAccountIdentityText,
  shouldAcceptReplyText,
} from '../src/providers/deepseek/adapter';
import { parseIndexResult } from '../src/core/protocol/schema';

describe('DeepSeek reply acceptance', () => {
  it('从动态 class 的侧栏短文本中识别脱敏手机号，并规范化空格', () => {
    expect(extractDeepSeekAccountIdentityText([
      '开启新对话今天人员画像',
      ' 177 * * * * * * 46 ',
    ])).toBe('177******46');
  });

  it('不从长聊天正文或普通数字中推断账号，支持邮箱展示', () => {
    expect(extractDeepSeekAccountIdentityText([
      '本次处理 177******46 条记录，正文很长'.repeat(20),
      '订单号 1234567890',
    ])).toBeUndefined();
    expect(extractDeepSeekAccountIdentityText(['user@example.com'])).toBe('user@example.com');
  });

  it('支持侧栏底部仅显示昵称的账号入口，并过滤普通界面文案', () => {
    expect(normalizeDeepSeekAccountLabel('托本起源')).toBe('托本起源');
    expect(normalizeDeepSeekAccountLabel('开启新对话')).toBeUndefined();
    expect(normalizeDeepSeekAccountLabel('123456')).toBeUndefined();
  });

  it('账号标识只保存稳定的不透明 key，不泄露原始账号文案', () => {
    const key = deriveDeepSeekAccountKey('177******46');
    expect(key).toMatch(/^deepseek:[0-9a-f]{8}$/);
    expect(key).not.toContain('177');
    expect(deriveDeepSeekAccountKey('177******46')).toBe(key);
    expect(deriveDeepSeekAccountKey('188******12')).not.toBe(key);
  });

  it('昵称账号保留可识别展示名，避免把会话标题当账号', () => {
    expect(describeDeepSeekAccount('托本起源')?.label).toBe('托本起源');
  });

  it('只从侧栏账号入口结构读取昵称，不从会话链接猜测', () => {
    const root = {
      querySelectorAll: (selector: string) => selector.includes('._9d8da05') ? [{
        innerText: '托本起源', textContent: '托本起源',
        closest: (value: string) => value.startsWith('a,') ? null : null,
        getClientRects: () => [{}],
      }] : [],
    } as unknown as ParentNode;
    expect(readDeepSeekAccountIdentityText(root)).toBe('托本起源');
  });

  it('页面空闲且回复稳定时，把格式错误的索引 JSON 交给核心层重试', () => {
    const malformed = '{"units":[{"id":"chunk-38-1","topic":"bad "quote"","sourceHints":["original"]}]}';
    expect(parseIndexResult(malformed)).toBeNull();
    expect(shouldAcceptReplyText(malformed, true, false, null)).toBe(false);
    expect(shouldAcceptReplyText(malformed, true, false, malformed)).toBe(true);
  });

  it('识别中英文对话长度上限提示，交给核心层换新会话', () => {
    expect(isDeepSeekConversationLimitText('达到对话长度上限，请开启新对话')).toBe(true);
    expect(isDeepSeekConversationLimitText('Conversation length limit reached. Start a new chat.')).toBe(true);
    expect(isDeepSeekConversationLimitText('普通回复：请开启新对话按钮')).toBe(false);
    expect(isDeepSeekConversationLimitText('本次回复已完成')).toBe(false);
  });

  it('生成中仍等待 JSON 完整，避免收集半截回复', () => {
    expect(shouldAcceptReplyText('{"topic":"进行中', true, true, '{"topic":"进行中')).toBe(false);
  });

  it('空回复始终不接受', () => {
    expect(shouldAcceptReplyText('  ', true, false, '  ')).toBe(false);
  });
});
