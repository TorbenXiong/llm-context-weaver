import { describe, expect, it } from 'vitest';
import {
  isReadyPingReply,
  isSameRemoteSession,
  isTransientNavigationError,
  mergeContinuationResults,
  requiresSubmissionSetup,
  shouldTryContinuationFallback,
} from '../src/providers/deepseek/runtime';
import type { CurrentUnit } from '../src/core/types';

describe('DeepSeek remote session URL', () => {
  it('查询参数、hash 和尾斜杠不同仍视为同一会话', () => {
    const base = 'https://chat.deepseek.com/a/chat/s/session-id';
    expect(isSameRemoteSession(`${base}/?from=history#bottom`, base)).toBe(true);
  });

  it('不同会话不会误判为相同', () => {
    expect(isSameRemoteSession(
      'https://chat.deepseek.com/a/chat/s/first',
      'https://chat.deepseek.com/a/chat/s/second',
    )).toBe(false);
  });

  it('只把 BFCache 消息通道关闭识别为导航瞬时错误', () => {
    expect(isTransientNavigationError(new Error(
      'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.',
    ))).toBe(true);
    expect(isTransientNavigationError(new Error('DeepSeek 页面未登录'))).toBe(false);
  });

  it('只接受带文档令牌且 URL 匹配的新版探活响应', () => {
    const target = 'https://chat.deepseek.com/a/chat/s/target';
    expect(isReadyPingReply({ ok: true, url: target, documentToken: 'document-1' }, target)).toBe(true);
    expect(isReadyPingReply({ ok: true, url: target }, target)).toBe(false);
    expect(isReadyPingReply({
      ok: true,
      url: 'https://chat.deepseek.com/a/chat/s/stale',
      documentToken: 'old-document',
    }, target)).toBe(false);
  });
});

describe('DeepSeek Provider preparation', () => {
  const unit = (phase: CurrentUnit['phase']): CurrentUnit => ({
    kind: 'extract',
    ref: '0',
    attempt: 1,
    marker: '[LCW test]',
    phase,
    remoteRef: 'https://chat.deepseek.com/a/chat/s/session-id',
  });

  it('只在真正提交前配置网页功能开关', () => {
    expect(requiresSubmissionSetup(unit('prepared'))).toBe(true);
    expect(requiresSubmissionSetup(unit('submitting'))).toBe(false);
    expect(requiresSubmissionSetup(unit('acknowledged'))).toBe(false);
  });
});

describe('DeepSeek continuation confirmation', () => {
  it('只把页面已发生变化的续写尝试视为成功', () => {
    expect(mergeContinuationResults([
      { found: true, attempted: true, confirmed: false, evidence: 'not_confirmed' },
      { found: true, attempted: true, confirmed: true, evidence: 'generating' },
    ])).toEqual({
      found: true,
      attempted: true,
      confirmed: true,
      evidence: 'generating',
    });
  });

  it('按钮存在但页面无变化时保留失败诊断', () => {
    expect(mergeContinuationResults([
      undefined,
      {
        found: true,
        attempted: true,
        confirmed: false,
        evidence: 'not_confirmed',
        detail: '页面无变化',
      },
    ])).toMatchObject({ found: true, attempted: true, confirmed: false, detail: '页面无变化' });
  });

  it('没有找到按钮时返回未尝试', () => {
    expect(mergeContinuationResults([])).toEqual({ found: false, attempted: false, confirmed: false });
  });

  it('浏览器级点击找到按钮但未确认时继续尝试备用点击链路', () => {
    expect(shouldTryContinuationFallback({
      found: true,
      attempted: true,
      confirmed: false,
      evidence: 'not_confirmed',
    })).toBe(true);
    expect(shouldTryContinuationFallback({
      found: true,
      attempted: true,
      confirmed: true,
      evidence: 'generating',
    })).toBe(false);
  });
});
