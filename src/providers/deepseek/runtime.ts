import type { ProviderHost, ProviderInspection, ProviderSubmitOutcome } from '../../core/provider';
import type { CurrentUnit, Job } from '../../core/types';
import type { DeepSeekCommand } from './messages';

const HOME = 'https://chat.deepseek.com/';
const URL_PATTERN = 'https://chat.deepseek.com/*';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tabIdOf = (connectionId: string): number => {
  const tabId = Number(connectionId);
  if (!Number.isInteger(tabId)) throw new Error(`非法 DeepSeek connectionId: ${connectionId}`);
  return tabId;
};

async function send(tabId: number, command: DeepSeekCommand): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, command);
}

async function waitUntilReady(tabId: number): Promise<void> {
  let triedInject = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const reply = await send(tabId, { channel: 'deepseek', type: 'ping' }) as { ok?: boolean } | null;
      if (reply?.ok) return;
    } catch {
      if (!triedInject) {
        triedInject = true;
        try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content/deepseek.js'] }); } catch { /* 页面仍可能加载中 */ }
      }
    }
    await wait(500);
  }
  throw new Error('DeepSeek 页面未就绪（请确认页面已打开且已登录）');
}

export class DeepSeekProviderHost implements ProviderHost {
  async connect(job: Job): Promise<string> {
    // legacy 是 v1 原型数据的迁移标记；当时唯一 Provider 就是 DeepSeek。
    if (job.providerId !== 'deepseek' && job.providerId !== 'legacy') {
      throw new Error(`不支持的 Provider: ${job.providerId}`);
    }
    const tabs = await chrome.tabs.query({ url: URL_PATTERN });
    let tab = tabs.find((candidate) => candidate.id != null) ?? null;
    if (!tab) tab = await chrome.tabs.create({ url: HOME, active: true });
    const tabId = tab.id;
    if (tabId == null) throw new Error('DeepSeek 标签页没有 tabId');
    if (tab.discarded) await chrome.tabs.reload(tabId).catch(() => undefined);
    await waitUntilReady(tabId);
    return String(tabId);
  }

  async prepare(connectionId: string, unit: CurrentUnit): Promise<void> {
    const tabId = tabIdOf(connectionId);
    if (unit.remoteRef) {
      const current = await chrome.tabs.get(tabId);
      if (current.url !== unit.remoteRef) {
        await chrome.tabs.update(tabId, { url: unit.remoteRef });
        await waitUntilReady(tabId);
      }
      return;
    }
    // 只有尚未开始提交的 claim 可以安全创建新会话。
    if (unit.phase === 'prepared') {
      const reply = await send(tabId, { channel: 'deepseek', type: 'newChat' }) as { ok?: boolean; error?: string } | null;
      if (!reply?.ok) throw new Error(reply?.error ?? '无法创建 DeepSeek 新会话');
    }
  }

  async submit(connectionId: string, _marker: string, prompt: string): Promise<ProviderSubmitOutcome> {
    const reply = await send(tabIdOf(connectionId), { channel: 'deepseek', type: 'sendPrompt', text: prompt }) as {
      outcome?: string;
      url?: string | null;
      error?: string;
    } | null;
    if (reply?.outcome === 'accepted') return { status: 'accepted', remoteRef: reply.url ?? null };
    if (reply?.outcome === 'rejected') return { status: 'rejected', detail: reply.error ?? 'DeepSeek 拒绝提交' };
    if (reply?.outcome === 'retryable') {
      return { status: 'retryable', detail: reply.error ?? 'DeepSeek 暂时忙碌', retryAfterMs: 5_000 };
    }
    return { status: 'ambiguous', detail: reply?.error ?? 'DeepSeek 提交结果不明确' };
  }

  async inspect(connectionId: string, unit: CurrentUnit): Promise<ProviderInspection> {
    const tabId = tabIdOf(connectionId);
    const status = await send(tabId, { channel: 'deepseek', type: 'status' }) as { state?: string } | null;
    if (status?.state === 'generating') return { status: 'generating', remoteRef: unit.remoteRef };
    if (status?.state !== 'idle') return { status: 'unavailable', detail: 'DeepSeek Adapter 暂不可用', retryAfterMs: 5_000 };
    const reply = await send(tabId, { channel: 'deepseek', type: 'readReply', marker: unit.marker }) as {
      found?: boolean;
      text?: string;
      error?: string;
    } | null;
    if (reply?.found && typeof reply.text === 'string' && reply.text.trim()) {
      return { status: 'complete', reply: reply.text, remoteRef: unit.remoteRef };
    }
    const marker = await send(tabId, { channel: 'deepseek', type: 'hasMarker', marker: unit.marker }) as { has?: boolean } | null;
    return { status: 'missing', detail: marker?.has ? '已找到请求 marker，但尚未找到对应回复' : '当前会话中没有请求 marker' };
  }
}
