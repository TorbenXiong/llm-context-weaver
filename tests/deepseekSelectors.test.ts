import { describe, expect, it } from 'vitest';
import { findConversationLimitNotice, findRateLimitNotice, isRateLimitNoticeText } from '../src/providers/deepseek/selectors';

const inlineNoticeRoot = (items: Array<{ text: string; inMessage?: boolean; visible?: boolean }>): ParentNode => ({
  querySelectorAll: (selector: string) => selector === '[data-virtual-list-item-key]'
    ? items.map(({ text, inMessage, visible }) => ({
      querySelector: () => ({}),
      querySelectorAll: () => [{
        children: [],
        closest: () => inMessage ? {} : null,
        getClientRects: () => visible === false ? [] : [{}],
        innerText: text,
      }],
    }))
    : [],
}) as unknown as ParentNode;

describe('DeepSeek 限流提示识别', () => {
  it('上下文上限只识别最新消息外可见错误，不扫描用户原文和模型引用', () => {
    const text = '达到对话长度上限，请开启新对话';
    expect(findConversationLimitNotice(inlineNoticeRoot([{ text }]))).toBe(text);
    expect(findConversationLimitNotice(inlineNoticeRoot([{ text, inMessage: true }]))).toBeNull();
    expect(findConversationLimitNotice(inlineNoticeRoot([{ text, visible: false }]))).toBeNull();
    expect(findConversationLimitNotice(inlineNoticeRoot([{ text }, { text: '新回复' }]))).toBeNull();
  });
  it('识别截图中的官方提示及常见英文提示', () => {
    expect(isRateLimitNoticeText('消息发送过于频繁，请稍后重试')).toBe(true);
    expect(isRateLimitNoticeText('Too many requests, try again later')).toBe(true);
  });

  it('不把普通正文误判为限流', () => {
    expect(isRateLimitNoticeText('请大家不要频繁发送无关消息')).toBe(false);
    expect(isRateLimitNoticeText('本次回复已完成')).toBe(false);
  });

  it('识别最新用户消息正文外的官方拒发提示', () => {
    expect(findRateLimitNotice(inlineNoticeRoot([
      { text: '消息发送过于频繁，请稍后重试' },
    ]))).toBe('消息发送过于频繁，请稍后重试');
  });

  it('忽略消息正文、隐藏提示及非最新消息的旧错误', () => {
    expect(findRateLimitNotice(inlineNoticeRoot([{ text: '消息发送过于频繁，请稍后重试', inMessage: true }]))).toBeNull();
    expect(findRateLimitNotice(inlineNoticeRoot([{ text: '消息发送过于频繁，请稍后重试', visible: false }]))).toBeNull();
    expect(findRateLimitNotice(inlineNoticeRoot([
      { text: '消息发送过于频繁，请稍后重试' },
      { text: '本次回复已完成' },
    ]))).toBeNull();
  });
});
