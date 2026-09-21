import type { ProviderCleanupResult, ProviderHost, ProviderInspection, ProviderSubmitOutcome } from '../../core/provider';
import type { CurrentUnit, Job } from '../../core/types';
import type { DeepSeekCommand, DeepSeekContinuationResult } from './messages';
import { DEEPSEEK_RATE_LIMIT_RETRY_MS } from './policy';

const HOME = 'https://chat.deepseek.com/';
const URL_PATTERN = 'https://chat.deepseek.com/*';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const command = <T extends Omit<DeepSeekCommand, 'channel'>>(value: T): DeepSeekCommand =>
  ({ channel: 'deepseek-v5', ...value }) as DeepSeekCommand;

/** 忽略查询参数、hash 和尾斜杠，避免同一会话因 URL 展示差异被反复重新导航。 */
export function isSameRemoteSession(left: string | undefined, right: string): boolean {
  if (!left) return false;
  try {
    const normalize = (value: string): string => {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    };
    return normalize(left) === normalize(right);
  } catch {
    return left === right;
  }
}

const tabIdOf = (connectionId: string): number => {
  const tabId = Number(connectionId);
  if (!Number.isInteger(tabId)) throw new Error(`非法 DeepSeek connectionId: ${connectionId}`);
  return tabId;
};

export function isTransientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /back\/forward cache|message channel is closed|receiving end does not exist/i.test(message);
}

interface DeepSeekPingReply {
  ok?: boolean;
  url?: string;
  documentToken?: string;
}

export function isReadyPingReply(
  reply: DeepSeekPingReply | null,
  expectedUrl?: string,
): reply is DeepSeekPingReply & { ok: true; documentToken: string } {
  return reply?.ok === true &&
    typeof reply.documentToken === 'string' &&
    reply.documentToken.length > 0 &&
    (!expectedUrl || isSameRemoteSession(reply.url, expectedUrl));
}

/** Provider 功能开关只属于发送前准备；已发送单元恢复时必须直接对账。 */
export function requiresSubmissionSetup(unit: CurrentUnit): boolean {
  return unit.phase === 'prepared';
}

async function send(tabId: number, command: DeepSeekCommand): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, command);
    } catch (error) {
      lastError = error;
      if (!isTransientNavigationError(error)) throw error;
      await wait(250);
    }
  }
  throw lastError;
}

async function waitUntilReady(tabId: number, expectedUrl?: string): Promise<void> {
  let triedInject = false;
  let injectError: unknown;
  let observedDocumentToken: string | null = null;
  const injectLatestContentScript = async (): Promise<void> => {
    if (triedInject) return;
    triedInject = true;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/deepseek.js'] });
      injectError = undefined;
    } catch (error) {
      // 页面可能仍在导航；保留真实错误，循环结束后向工作台报告。
      injectError = error;
    }
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const reply = await send(tabId, command({ type: 'ping' })) as DeepSeekPingReply | null;
      if (isReadyPingReply(reply, expectedUrl)) {
        // 连续两次必须来自同一新文档，避免导航边界上旧 BFCache 文档的一次性响应。
        if (observedDocumentToken === reply.documentToken) return;
        observedDocumentToken = reply.documentToken;
      } else {
        observedDocumentToken = null;
        // 旧 Content Script 的监听器可能收到新版 channel 后直接忽略，使
        // sendMessage 正常返回 undefined 而不是抛错。此时也必须主动注入新版脚本。
        await injectLatestContentScript();
      }
    } catch {
      await injectLatestContentScript();
    }
    await wait(500);
  }
  const suffix = injectError
    ? `；Content Script 注入失败: ${injectError instanceof Error ? injectError.message : String(injectError)}`
    : '';
  throw new Error(`DeepSeek 页面未就绪（请确认页面已打开且已登录）${suffix}`);
}

/** 导航后必须确认 tab 已到达目标会话并结束加载，不能被旧页面残留的 ping 响应提前放行。 */
async function waitUntilAtSession(tabId: number, remoteRef: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (isSameRemoteSession(tab.url, remoteRef) && tab.status === 'complete') {
      // complete 后再让出一个事件循环，避免刚进入 BFCache 的旧 content script 抢答。
      await wait(250);
      const confirmed = await chrome.tabs.get(tabId);
      if (isSameRemoteSession(confirmed.url, remoteRef) && confirmed.status === 'complete') return;
    }
    await wait(250);
  }
  throw new Error('DeepSeek 目标会话加载超时');
}

/**
 * 只保证标签页可用，不依赖 Content Script。恢复已发送任务时应先走这个轻量路径，
 * 否则旧脚本、BFCache 或消息端口失效会挡在“继续生成”按钮之前。
 */
async function ensureTabAvailable(tabId: number): Promise<chrome.tabs.Tab> {
  let tab = await chrome.tabs.get(tabId);
  if (tab.autoDiscardable !== false) {
    const updated = await chrome.tabs.update(tabId, { autoDiscardable: false });
    if (updated) tab = updated;
  }
  if (tab.discarded) await chrome.tabs.reload(tabId);
  return chrome.tabs.get(tabId);
}

/**
 * 后台标签页可能被 Chrome Memory Saver 丢弃，Content Script 也可能因页面恢复而暂时失联。
 * 每次 Provider 操作前恢复并探活，但不激活标签页、不抢占用户焦点。
 */
async function ensureTabReady(tabId: number): Promise<chrome.tabs.Tab> {
  await ensureTabAvailable(tabId);
  await waitUntilReady(tabId);
  return chrome.tabs.get(tabId);
}

/**
 * 自动续写是单一、稳定的 DOM 动作，优先通过 scripting 直接执行，不依赖长连接消息端口。
 * 其余状态读取与结果收集仍由 Adapter 完成，Provider 私有 DOM 不进入核心层。
 */
export function mergeContinuationResults(
  results: readonly (DeepSeekContinuationResult | undefined)[],
): DeepSeekContinuationResult {
  return results.find((result) => result?.confirmed) ??
    results.find((result) => result?.found) ??
    { found: false, attempted: false, confirmed: false };
}

/** 浏览器级点击未确认时必须继续走 Adapter/Main Probe，不能提前报错。 */
export function shouldTryContinuationFallback(result: DeepSeekContinuationResult): boolean {
  return result.found && !result.confirmed;
}

async function clickContinueDirectly(tabId: number): Promise<DeepSeekContinuationResult> {
  const targets = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (): { found: boolean; x?: number; y?: number; replyLength?: number } => {
      const isDisabled = (el: HTMLElement): boolean =>
        el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('disabled') ||
        el.classList.contains('ds-button--disabled');
      const isVisible = (el: HTMLElement): boolean => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .filter((el) => {
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          return /^(继续生成|Continue generating|Continue generation|Continue)$/i.test(text) &&
            !isDisabled(el) &&
            isVisible(el);
        });
      const button = candidates.at(-1);
      if (!button) return { found: false };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      const replies = document.querySelectorAll<HTMLElement>(
        '.ds-markdown, .ds-assistant-message-main-content, [class*="markdown-body"]',
      );
      return {
        found: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        replyLength: Array.from(replies).reduce((total, el) => total + (el.textContent ?? '').length, 0),
      };
    },
  });
  const target = targets.find((result) => result.result?.found)?.result;
  if (!target?.found || target.x == null || target.y == null) {
    return { found: false, attempted: false, confirmed: false };
  }

  const debuggee: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: target.x, y: target.y,
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1,
    });
  } catch (error) {
    return {
      found: true,
      attempted: true,
      confirmed: false,
      evidence: 'not_confirmed',
      detail: `无法发送浏览器级续写点击：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => undefined);
  }

  const confirmations = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [target.replyLength ?? 0],
    func: async (beforeReplyLength: number): Promise<DeepSeekContinuationResult> => {
      const isVisible = (el: HTMLElement): boolean => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
      };
      const isDisabled = (el: HTMLElement): boolean =>
        el.getAttribute('aria-disabled') === 'true' ||
        el.hasAttribute('disabled') ||
        el.classList.contains('ds-button--disabled');
      const continueButtons = (): HTMLElement[] =>
        Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
          .filter((el) => {
            const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
            return /^(继续生成|Continue generating|Continue generation|Continue)$/i.test(text) && isVisible(el);
          });
      const replyTextLength = (): number =>
        Array.from(document.querySelectorAll<HTMLElement>(
          '.ds-markdown, .ds-assistant-message-main-content, [class*="markdown-body"]',
        )).reduce((total, el) => total + (el.textContent ?? '').length, 0);
      const generating = (): boolean => [
        'div[role="button"].ds-button--primary:has(svg rect)',
        '[aria-label*="停止"]',
        '[aria-label*="stop" i]',
      ].some((selector) => {
        try {
          return Array.from(document.querySelectorAll<HTMLElement>(selector))
            .some((el) => isVisible(el) && !isDisabled(el));
        } catch {
          return false;
        }
      });

      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const buttons = continueButtons();
        if (buttons.length === 0) {
          return { found: true, attempted: true, confirmed: true, evidence: 'button_disappeared' };
        }
        if (buttons.every(isDisabled)) {
          return { found: true, attempted: true, confirmed: true, evidence: 'button_disabled' };
        }
        if (generating()) {
          return { found: true, attempted: true, confirmed: true, evidence: 'generating' };
        }
        if (replyTextLength() > beforeReplyLength) {
          return { found: true, attempted: true, confirmed: true, evidence: 'reply_grew' };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        found: true,
        attempted: true,
        confirmed: false,
        evidence: 'not_confirmed',
        detail: '已发送浏览器级续写点击，但 4 秒内按钮、生成状态和回复内容均无变化',
      };
    },
  });
  return mergeContinuationResults(confirmations.map((result) => result.result));
}

export class DeepSeekProviderHost implements ProviderHost {
  async connect(job: Job): Promise<string> {
    // legacy 是 v1 原型数据的迁移标记；当时唯一 Provider 就是 DeepSeek。
    if (job.providerId !== 'deepseek' && job.providerId !== 'legacy') {
      throw new Error(`不支持的 Provider: ${job.providerId}`);
    }
    let tab: chrome.tabs.Tab | null = null;
    if (job.providerConnectionId) {
      const savedTabId = Number(job.providerConnectionId);
      if (Number.isInteger(savedTabId)) {
        tab = await chrome.tabs.get(savedTabId).catch(() => null);
        if (tab && !tab.url?.startsWith('https://chat.deepseek.com/')) tab = null;
      }
    }
    if (!tab) {
      const tabs = await chrome.tabs.query({ url: URL_PATTERN });
      tab = tabs.find((candidate) => candidate.id != null) ?? null;
    }
    if (!tab) tab = await chrome.tabs.create({ url: HOME, active: true });
    const tabId = tab.id;
    if (tabId == null) throw new Error('DeepSeek 标签页没有 tabId');
    await ensureTabAvailable(tabId);
    return String(tabId);
  }

  async prepare(connectionId: string, unit: CurrentUnit): Promise<void> {
    const tabId = tabIdOf(connectionId);
    const readyTab = await ensureTabAvailable(tabId);
    if (unit.remoteRef) {
      if (!isSameRemoteSession(readyTab.url, unit.remoteRef)) {
        await chrome.tabs.update(tabId, { url: unit.remoteRef });
        await waitUntilAtSession(tabId, unit.remoteRef);
      }
      if (requiresSubmissionSetup(unit)) {
        await waitUntilReady(tabId, unit.remoteRef);
        await this.configureFeatures(tabId, unit);
      }
      return;
    }
    // 已发送但尚未取得 remoteRef 的模糊投递只能在当前页对账，不能重配开关或新建会话。
    if (!requiresSubmissionSetup(unit)) return;
    await waitUntilReady(tabId);
    const reply = await send(tabId, command({ type: 'newChat' })) as { ok?: boolean; error?: string } | null;
    if (!reply?.ok) throw new Error(reply?.error ?? '无法创建 DeepSeek 新会话');
    await this.configureFeatures(tabId, unit);
  }

  private async configureFeatures(tabId: number, unit: CurrentUnit): Promise<void> {
    const reply = await send(tabId, command({
      type: 'setFeatures',
      deepThinking: unit.deepThinking === true,
      smartSearch: unit.smartSearch === true,
    })) as { ok?: boolean; error?: string } | null;
    if (!reply?.ok) throw new Error(reply?.error ?? 'DeepSeek 能力开关未就绪');
  }

  async submit(connectionId: string, _marker: string, prompt: string): Promise<ProviderSubmitOutcome> {
    const tabId = tabIdOf(connectionId);
    await ensureTabReady(tabId);
    const reply = await send(tabId, command({ type: 'sendPrompt', text: prompt })) as {
      outcome?: string;
      url?: string | null;
      error?: string;
    } | null;
    if (reply?.outcome === 'accepted') return { status: 'accepted', remoteRef: reply.url ?? null };
    if (reply?.outcome === 'rejected') return { status: 'rejected', detail: reply.error ?? 'DeepSeek 拒绝提交' };
    if (reply?.outcome === 'retryable') {
      return { status: 'retryable', detail: reply.error ?? 'DeepSeek 暂时忙碌', retryAfterMs: 5_000 };
    }
    if (reply?.outcome === 'rate_limited') {
      return {
        status: 'rate_limited',
        detail: reply.error ?? 'DeepSeek 消息发送过于频繁，30 分钟后重试',
        retryAfterMs: DEEPSEEK_RATE_LIMIT_RETRY_MS,
      };
    }
    return { status: 'ambiguous', detail: reply?.error ?? 'DeepSeek 提交结果不明确' };
  }

  async inspect(connectionId: string, unit: CurrentUnit): Promise<ProviderInspection> {
    const tabId = tabIdOf(connectionId);
    const asInspection = (result: DeepSeekContinuationResult): ProviderInspection | null => {
      if (result.confirmed) return { status: 'generating', remoteRef: unit.remoteRef };
      if (!result.found) return null;
      return {
        status: 'unavailable',
        detail: `检测到“继续生成”，但 DeepSeek 页面未响应自动续写：${result.detail ?? '未观察到生成状态变化'}`,
        retryAfterMs: 5_000,
        remoteRef: unit.remoteRef,
      };
    };
    await ensureTabAvailable(tabId);
    // 续写不应被 Content Script 探活阻塞；页面按钮存在时直接恢复生成。
    let directResult: DeepSeekContinuationResult = { found: false, attempted: false, confirmed: false };
    try {
      directResult = await clickContinueDirectly(tabId);
    } catch {
      // 页面导航或脚本执行短暂失败时，继续走已具备探活和重注入能力的 Adapter 链路。
    }
    if (!shouldTryContinuationFallback(directResult)) {
      const directContinuation = asInspection(directResult);
      if (directContinuation) return directContinuation;
    }
    await waitUntilReady(tabId, unit.remoteRef ?? undefined);
    // “继续生成”是生成达到上限后的终态控件，必须优先于普通生成状态探测。
    // DeepSeek 可能同时保留一个可见但 disabled 的主按钮；若先查 status，
    // 会把这种状态误判为仍在生成，从而永远跳过继续按钮。
    const continuation = await send(tabId, command({
      type: 'continueGeneration',
      marker: unit.marker,
    })) as DeepSeekContinuationResult | null;
    if (continuation) {
      const continuationInspection = asInspection(continuation);
      if (continuationInspection) return continuationInspection;
    }
    const status = await send(tabId, command({ type: 'status' })) as { state?: string } | null;
    if (status?.state === 'generating') return { status: 'generating', remoteRef: unit.remoteRef };
    if (status?.state !== 'idle') return { status: 'unavailable', detail: 'DeepSeek Adapter 暂不可用', retryAfterMs: 5_000 };
    const reply = await send(tabId, command({
      type: 'readReply',
      marker: unit.marker,
      expectJson: unit.outputFormat !== 'text',
    })) as {
      found?: boolean;
      text?: string;
      error?: string;
    } | null;
    if (reply?.found && typeof reply.text === 'string' && reply.text.trim()) {
      const continuationAfterReply = await send(tabId, command({
        type: 'continueGeneration',
        marker: unit.marker,
      })) as DeepSeekContinuationResult | null;
      if (continuationAfterReply) {
        const continuationInspection = asInspection(continuationAfterReply);
        if (continuationInspection) return continuationInspection;
      }
      // 读取回复期间生成状态可能发生变化；以最新状态为准，避免把仍在生成的半成品交给核心。
      const latestStatus = await send(tabId, command({ type: 'status' })) as { state?: string } | null;
      if (latestStatus?.state === 'generating') return { status: 'generating', remoteRef: unit.remoteRef };
      return { status: 'complete', reply: reply.text, remoteRef: unit.remoteRef };
    }
    // 首次状态检查与读取回复之间可能正好进入生成阶段，再复核一次可避免误报 missing。
    const continuationAfterRead = await send(tabId, command({
      type: 'continueGeneration',
      marker: unit.marker,
    })) as DeepSeekContinuationResult | null;
    if (continuationAfterRead) {
      const continuationInspection = asInspection(continuationAfterRead);
      if (continuationInspection) return continuationInspection;
    }
    const latestStatus = await send(tabId, command({ type: 'status' })) as { state?: string } | null;
    if (latestStatus?.state === 'generating') return { status: 'generating', remoteRef: unit.remoteRef };
    const marker = await send(tabId, command({ type: 'hasMarker', marker: unit.marker })) as { has?: boolean } | null;
    return { status: 'missing', detail: marker?.has ? '已找到请求 marker，但尚未找到对应回复' : '当前会话中没有请求 marker' };
  }

  async cleanupSessions(connectionId: string, sessionRefs: readonly string[]): Promise<ProviderCleanupResult> {
    const tabId = tabIdOf(connectionId);
    await ensureTabReady(tabId);
    const reply = await send(tabId, command({ type: 'deleteSessions', sessionRefs: [...sessionRefs] })) as {
      ok?: boolean;
      error?: string;
      deletedRefs?: string[];
      missingRefs?: string[];
    } | null;
    if (!reply) throw new Error('DeepSeek 会话清理无响应');
    if (!reply.ok && !reply.missingRefs && !reply.deletedRefs) throw new Error(reply.error ?? 'DeepSeek 会话清理失败');
    return { deletedRefs: reply.deletedRefs ?? [], missingRefs: reply.missingRefs ?? [] };
  }
}
