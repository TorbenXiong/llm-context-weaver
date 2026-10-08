import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeepSeekProviderHost,
  isDeepSeekHome,
  isDeepSeekRemoteSessionMissingError,
  isReadyPingReply,
  isSameRemoteSession,
  isTransientNavigationError,
  hasRepeatedReplyTail,
  mergeContinuationResults,
  requiresSubmissionSetup,
  shouldTryContinuationFallback,
} from '../src/providers/deepseek/runtime';
import type { CurrentUnit } from '../src/core/types';
import type { DeepSeekCommand } from '../src/providers/deepseek/messages';

describe('DeepSeek 上下文超限对账', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([false, true])('优先收集当前 marker 的完整 JSON，manual=%s', async (manualIntervention) => {
    vi.useFakeTimers();
    const remoteRef = 'https://chat.deepseek.com/a/chat/s/test';
    const raw = '{"knowledge":[{"category":"事实","topic":"错误提示","content":"达到对话长度上限，请开启新对话"}]}';
    const sendMessage = vi.fn(async (_id: number, message: DeepSeekCommand) => {
      if (message.type === 'ping') return { ok: true, url: remoteRef, documentToken: 'current-document' };
      if (message.type === 'status') return { state: 'conversation_limit' };
      if (message.type === 'readReply') return { found: true, text: raw };
      throw new Error(`不应执行 ${message.type}`);
    });
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', { tabs: { get: async () => ({ url: remoteRef, autoDiscardable: false }), sendMessage }, scripting: { executeScript } });
    const inspection = new DeepSeekProviderHost().inspect('1', {
      kind: 'extract', ref: '0', attempt: 1, marker: '[LCW current]', phase: 'acknowledged',
      outputFormat: 'knowledge-json', remoteRef, manualIntervention,
    });
    await vi.runAllTimersAsync();
    expect(await inspection).toMatchObject({ status: 'complete', reply: raw });
    expect(sendMessage.mock.calls.find(([, message]) => message.type === 'readReply')?.[1]).toMatchObject({ marker: '[LCW current]' });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it.each(['knowledge-json', 'text'] as const)('超限时不会把半截 %s 当作完整结果', async (outputFormat) => {
    const sendMessage = vi.fn(async (_id: number, message: DeepSeekCommand) => message.type === 'status'
      ? { state: 'conversation_limit' } : { found: true, text: '{"knowledge":[' });
    vi.stubGlobal('chrome', { tabs: { get: async () => ({ autoDiscardable: false }), sendMessage } });
    expect(await new DeepSeekProviderHost().inspect('1', {
      kind: 'extract', ref: '0', attempt: 1, marker: '[LCW current]', phase: 'acknowledged',
      manualIntervention: true, outputFormat,
    })).toMatchObject({ status: 'retry_current', strategy: 'split_input' });
  });
});

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

  it('可以识别被删除后重定向到首页的会话', () => {
    expect(isDeepSeekHome('https://chat.deepseek.com/')).toBe(true);
    expect(isDeepSeekHome('https://chat.deepseek.com/a/chat/s/session-id')).toBe(false);
    expect(isDeepSeekRemoteSessionMissingError({ code: 'remote_session_missing' })).toBe(true);
  });
});

describe('DeepSeek continuation confirmation', () => {
  it('只识别回复尾部连续重复，短重复片段不触发', () => {
    const repeated = '说明OA账号同步；说明OA密码修改；'.repeat(12);
    expect(hasRepeatedReplyTail(`正常内容。${repeated}`)).toBe(true);
    expect(hasRepeatedReplyTail('说明OA账号同步；说明OA密码修改；'.repeat(2))).toBe(false);
    expect(shouldTryContinuationFallback({
      found: true,
      attempted: false,
      confirmed: false,
      evidence: 'repeated_tail',
    })).toBe(false);
  });

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
