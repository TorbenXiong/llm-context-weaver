/**
 * DeepSeek Adapter（Provider 的第一个实现）。
 * 职责仅限 DOM 操作：输入发送、生成状态检测、回复读取、限流识别、新对话管理。
 * 不包含任何任务 / 分块 / 归并知识，Provider runtime 通过 DeepSeekCommand 驱动它。
 *
 * 独立对话模式：引擎每个工作单元一个新对话（DeepSeek 上下文窗口有限，
 * 且长会话虚拟滚动会卸载早期回复）。发送后轮询等待 URL 从 "/" 变为
 * "/a/chat/s/<id>"，通过 urlChanged 事件上报给引擎持久化。
 */
import type { AdapterEvent } from '../../core/messaging';
import type { DeepSeekCommand, DeepSeekContinuationResult } from './messages';
import { DEEPSEEK_RATE_LIMIT_RETRY_MS } from './policy';
import {
  INPUT_SELECTORS,
  MARKDOWN_SELECTORS,
  NEW_CHAT_SELECTORS,
  RATE_LIMIT_PATTERNS,
  SEND_BUTTON_DISABLED_CLASS,
  SEND_BUTTON_SELECTORS,
  queryAll,
  queryFirst,
} from './selectors';

const TICK_MS = 250;
const HEARTBEAT_MS = 1_000;
const RATE_CHECK_MS = 2_000;
const RATE_COOLDOWN_MS = 30_000;
/** 发送后等待会话 URL 出现的最长时间（DeepSeek 首 token 前 URL 就会变） */
const URL_WAIT_MS = 10_000;
const ACCEPT_STABILITY_MS = 600;
/** 兜底护栏：同一会话已堆积这么多回复时禁止继续发送（应由引擎的独立对话逻辑避免） */
const MAX_MD_PER_CHAT = 40;
const MAIN_PROBE_REQUEST = '__lcwReqV5';
const MAIN_PROBE_RESPONSE = '__lcwResV5';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * DeepSeek 会先把最终消息节点挂到 DOM，再继续补齐代码块内容。
 * 只要回复中的 JSON 对象尚未闭合，就不能交给核心解析，否则会把
 * 一次短暂的半截回复误判成失败并重发同一个工作单元。
 */
function hasCompleteJsonObject(text: string): boolean {
  const start = text.indexOf('{');
  if (start < 0) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/** DeepSeek 输入框是受控组件，必须走原生 setter + input 事件才能被框架感知 */
function setNativeValue(el: HTMLTextAreaElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  // InputEvent 比普通 Event 更接近真实输入，确保受控组件框架刷新状态
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export class DeepSeekAdapter {
  private generating = false;
  private lastTick = 0;
  private lastRateCheck = 0;
  private lastRateHit = 0;
  private tickRunning = false;
  private lastContinueMarker = '';
  private lastContinueAt = 0;

  private reqId = 0;

  constructor(private readonly emit: (e: AdapterEvent) => void) {}

  /** 与 MAIN world 探针桥接（content script 的 isolated world 看不到主世界渲染的 .ds-markdown） */
  private callMainProbe<T extends object>(action: string, extra: Record<string, unknown> = {}, timeoutMs = 4_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('mainProbe 无响应'));
      }, timeoutMs);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== window || !e.data || (e.data as Record<string, unknown>)[MAIN_PROBE_RESPONSE] !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(e.data as T);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ [MAIN_PROBE_REQUEST]: id, action, ...extra }, '*');
    });
  }

  start(): void {
    new MutationObserver(() => this.tick()).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.setInterval(() => this.tick(), HEARTBEAT_MS);
    this.tick();
  }

  async handle(cmd: DeepSeekCommand): Promise<unknown> {
    switch (cmd.type) {
      case 'ping':
        return { ok: true, url: location.href };
      case 'status': {
        if (!this.findInput()) return { state: 'unknown' };
        const gen = await this.isGenerating();
        return { state: gen ? 'generating' : 'idle' };
      }
      case 'newChat':
        return this.newChat();
      case 'setFeatures':
        return this.setFeatures(cmd.deepThinking, cmd.smartSearch);
      case 'hasMarker':
        return this.callMainProbe('hasMarker', { marker: cmd.marker });
      case 'sendPrompt':
        return this.sendPrompt(cmd.text);
      case 'readReply':
        return this.readReply(cmd.marker, cmd.expectJson);
      case 'continueGeneration':
        return this.continueGeneration(cmd.marker);
      case 'deleteSessions':
        return this.deleteSessions(cmd.sessionRefs);
      default:
        return { ok: false, error: 'unknown command' };
    }
  }

  private findInput(): HTMLTextAreaElement | null {
    const el = queryFirst(INPUT_SELECTORS);
    return el instanceof HTMLTextAreaElement ? el : null;
  }

  /**
   * 优先让 MAIN 探针处理；探针刚升级、页面从 BFCache 恢复或桥接暂时失联时，
   * Content Script 直接点击当前会话最后一个可见按钮作为恢复兜底。
   */
  private async continueGeneration(marker: string): Promise<DeepSeekContinuationResult> {
    if (this.lastContinueMarker === marker && Date.now() - this.lastContinueAt < 3_000) {
      return {
        found: true,
        attempted: false,
        confirmed: false,
        evidence: 'not_confirmed',
        detail: '距离上次续写尝试不足 3 秒',
      };
    }
    try {
      const result = await this.callMainProbe<DeepSeekContinuationResult>('continueGeneration', { marker }, 5_000);
      if (result.found) {
        this.lastContinueMarker = marker;
        this.lastContinueAt = Date.now();
        return result;
      }
    } catch {
      // 继续走 isolated world DOM 兜底。
    }
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .filter((el) => {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!/^(继续生成|Continue generating|Continue generation|Continue)$/i.test(text)) return false;
        if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return false;
        if (el.classList.contains('ds-button--disabled')) return false;
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const button = candidates.at(-1);
    if (!button) return { found: false, attempted: false, confirmed: false };
    const beforeReplyLength = queryAll(MARKDOWN_SELECTORS)
      .reduce((total, el) => total + (el.textContent ?? '').length, 0);
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.focus({ preventScroll: true });
    const rect = button.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    button.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
    button.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, view: window, buttons: 1 }));
    button.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
    button.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, view: window, buttons: 0 }));
    button.dispatchEvent(new MouseEvent('click', { ...eventInit, view: window, buttons: 0 }));
    this.lastContinueMarker = marker;
    this.lastContinueAt = Date.now();
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      await wait(100);
      if (!button.isConnected || button.offsetParent === null) {
        return { found: true, attempted: true, confirmed: true, evidence: 'button_disappeared' };
      }
      if (this.isDisabled(button)) {
        return { found: true, attempted: true, confirmed: true, evidence: 'button_disabled' };
      }
      if (await this.isGenerating()) {
        return { found: true, attempted: true, confirmed: true, evidence: 'generating' };
      }
      const replyLength = queryAll(MARKDOWN_SELECTORS)
        .reduce((total, el) => total + (el.textContent ?? '').length, 0);
      if (replyLength > beforeReplyLength) {
        return { found: true, attempted: true, confirmed: true, evidence: 'reply_grew' };
      }
    }
    return {
      found: true,
      attempted: true,
      confirmed: false,
      evidence: 'not_confirmed',
      detail: '已触发续写控件，但 4 秒内按钮、生成状态和回复内容均无变化',
    };
  }

  /** 将任务配置映射到 DeepSeek 输入框下方的两个网页开关。 */
  private async setFeatures(deepThinking: boolean, smartSearch: boolean): Promise<{ ok: boolean; error?: string }> {
    const desired: Array<[string, boolean]> = [['深度思考', deepThinking], ['智能搜索', smartSearch]];
    for (const [label, enabled] of desired) {
      let toggle: HTMLElement | null = null;
      for (let attempt = 0; attempt < 20 && !toggle; attempt++) {
        toggle = this.findFeatureToggle(label);
        if (!toggle) await wait(100);
      }
      if (!toggle) return { ok: false, error: `找不到 DeepSeek “${label}”开关` };
      const current = toggle.getAttribute('aria-pressed') === 'true' || toggle.classList.contains('ds-toggle-button--selected');
      if (current !== enabled) toggle.click();
      await wait(100);
      const after = toggle.getAttribute('aria-pressed') === 'true' || toggle.classList.contains('ds-toggle-button--selected');
      if (after !== enabled) return { ok: false, error: `DeepSeek “${label}”开关未能切换到${enabled ? '开启' : '关闭'}` };
    }
    return { ok: true };
  }

  private findFeatureToggle(label: string): HTMLElement | null {
    const direct = Array.from(document.querySelectorAll<HTMLElement>('[aria-pressed]'))
      .find((el) => (el.textContent ?? '').trim().includes(label));
    if (direct) return direct;
    const text = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .find((el) => (el.textContent ?? '').trim() === label);
    return text?.closest<HTMLElement>('[aria-pressed]') ?? null;
  }

  private isDisabled(el: HTMLElement): boolean {
    return (
      el.classList.contains(SEND_BUTTON_DISABLED_CLASS) ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute('disabled')
    );
  }

  private findSendButton(): HTMLElement | null {
    const hit = queryFirst(SEND_BUTTON_SELECTORS);
    if (hit instanceof HTMLElement) return hit;
    // 兜底：输入框附近可见的最后一个 button 元素
    const input = this.findInput();
    const scope = input?.closest('form') ?? input?.parentElement?.parentElement ?? null;
    if (!scope) return null;
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>('[role="button"], button')).filter(
      (b) => b.offsetParent !== null,
    );
    return candidates.at(-1) ?? null;
  }

  /** 生成中检测走 MAIN world 探针（isolated world 里选择器不可靠） */
  private async isGenerating(): Promise<boolean> {
    try {
      const r = await this.callMainProbe<{ generating?: boolean }>('isGenerating', {}, 1_500);
      return r.generating === true;
    } catch {
      return false; // 探针未就绪时保守按空闲处理，由超时对账兜底
    }
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastTick < TICK_MS || this.tickRunning) return;
    this.lastTick = now;
    this.tickRunning = true;
    void this.isGenerating()
      .then((generating) => {
        // 必须在异步探针返回后比较；否则最后一次 DOM mutation 会永远丢失 generationEnd。
        if (generating !== this.generating) {
          this.generating = generating;
          this.emit({ channel: 'adapter', type: generating ? 'generationStart' : 'generationEnd' });
        }
        // 限流扫描只在空闲时低频进行（全文 innerText 有成本）
        const checkedAt = Date.now();
        if (!generating && checkedAt - this.lastRateCheck > RATE_CHECK_MS && checkedAt - this.lastRateHit > RATE_COOLDOWN_MS) {
          this.lastRateCheck = checkedAt;
          const text = document.body?.innerText ?? '';
          for (const pattern of RATE_LIMIT_PATTERNS) {
            if (pattern.test(text)) {
              this.lastRateHit = checkedAt;
              this.emit({
                channel: 'adapter',
                type: 'rateLimited',
                detail: 'DeepSeek 消息发送过于频繁，30 分钟后重试',
                retryAfterMs: DEEPSEEK_RATE_LIMIT_RETRY_MS,
              });
              break;
            }
          }
        }
      })
      .finally(() => { this.tickRunning = false; });
  }

  /** 开新对话：优先点"开启新对话"按钮（无 aria-label，按文本找），失败则跳首页 */
  private async newChat(): Promise<{ ok: boolean; error?: string }> {
    if (location.pathname !== '/') {
      const btn = this.findNewChatButton();
      if (btn) {
        btn.click();
      } else {
        // SPA 内跳转更可靠：先 history 后 dispatch popstate，React Router 能感知
        history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await wait(250);
      const input = this.findInput();
      if (location.pathname === '/' && input && input.value.trim() === '') {
        await wait(300); // 等 React 稳定
        return { ok: true };
      }
    }
    return { ok: false, error: '新对话页面未就绪' };
  }

  /** DeepSeek 的"开启新对话"是无 aria-label 的普通 div，按文本在叶子级可点元素中定位 */
  private findNewChatButton(): HTMLElement | null {
    const aria = queryFirst(NEW_CHAT_SELECTORS);
    if (aria instanceof HTMLElement) return aria;
    // 从包含目标文本的最深层元素向外找最近的自身可点（cursor:pointer / 有 click 语义）祖先
    const all = Array.from(document.querySelectorAll<HTMLElement>('body *'));
    for (const el of all) {
      if (!(el.textContent ?? '').includes('开启新对话')) continue;
      let node: HTMLElement | null = el;
      for (let depth = 0; node && depth < 4; depth++) {
        const style = getComputedStyle(node);
        if (style.cursor === 'pointer') return node;
        node = node.parentElement;
      }
    }
    return null;
  }

  private async sendPrompt(text: string): Promise<{
    outcome: 'accepted' | 'rejected' | 'retryable' | 'rate_limited' | 'ambiguous';
    url?: string | null;
    error?: string;
  }> {
    const input = this.findInput();
    if (!input) return { outcome: 'rejected', error: '找不到输入框（页面未就绪或未登录）' };
    // 护栏：当前会话回复数异常时不继续发送，提示需要新对话
    const mdCount = queryAll(MARKDOWN_SELECTORS).length;
    if (mdCount >= MAX_MD_PER_CHAT) {
      return { outcome: 'rejected', error: `当前会话已有 ${mdCount} 条回复，需先 newChat` };
    }
    input.focus();
    setNativeValue(input, text);
    for (let i = 0; i < 30; i++) {
      const btn = this.findSendButton();
      if (btn && !this.isDisabled(btn)) {
        btn.click();
        // 点击后必须取得可观察确认；仅“调用 click”不能证明页面已接收。
        const confirmation = await this.waitForSubmissionConfirmation(text, URL_WAIT_MS);
        const url = confirmation.url;
        if (url) this.emit({ channel: 'adapter', type: 'remoteRefChanged', detail: url });
        if (confirmation.outcome === 'accepted') return { outcome: 'accepted', url };
        if (confirmation.outcome === 'retryable') return { outcome: 'retryable', url, error: confirmation.error };
        if (confirmation.outcome === 'rate_limited') return { outcome: 'rate_limited', url, error: confirmation.error };
        return { outcome: 'ambiguous', url, error: '点击发送后未观察到输入框清空、生成开始或会话 URL 变化' };
      }
      await wait(100);
    }
    return { outcome: 'rejected', error: '发送按钮不可用' };
  }

  private async waitForSubmissionConfirmation(
    originalText: string,
    timeoutMs: number,
  ): Promise<{ outcome: 'accepted' | 'retryable' | 'rate_limited' | 'ambiguous'; url: string | null; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let acceptedAt: number | null = null;
    while (Date.now() < deadline) {
      const url = location.pathname.startsWith('/a/chat/') ? location.href : null;
      const bodyText = document.body?.innerText ?? '';
      if (bodyText.includes('有消息正在生成，请稍后再试')) {
        return { outcome: 'retryable', url, error: 'DeepSeek 仍有消息正在生成' };
      }
      if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(bodyText))) {
        return { outcome: 'rate_limited', url, error: 'DeepSeek 消息发送过于频繁，30 分钟后重试' };
      }
      const input = this.findInput();
      const generating = await this.isGenerating();
      if (url || generating || (input && input.value !== originalText)) {
        acceptedAt ??= Date.now();
        if (Date.now() - acceptedAt >= ACCEPT_STABILITY_MS) return { outcome: 'accepted', url };
      }
      await wait(200);
    }
    return { outcome: 'ambiguous', url: location.pathname.startsWith('/a/chat/') ? location.href : null };
  }

  /**
   * 读取回复：走 MAIN world 探针（isolated world 看不到主世界渲染的回复）。
   * 找不到时让探针向上滚动触发虚拟列表加载，再重试。
   */
  private async readReply(marker: string, expectJson: boolean): Promise<{ found: boolean; text?: string; error?: string }> {
    for (let round = 0; round < 5; round++) {
      try {
        const r = await this.callMainProbe<{ found?: boolean; text?: string }>('readReply', { marker });
        if (
          r.found === true &&
          typeof r.text === 'string' &&
          r.text.trim().length > 0 &&
          (!expectJson || hasCompleteJsonObject(r.text))
        ) {
          return { found: true, text: r.text };
        }
        await this.callMainProbe('scrollUp').catch(() => undefined);
      } catch {
        // 探针未注入（页面刚从旧版扩展加载）：等待下轮
      }
      await wait(700);
    }
    return { found: false, error: 'reply not found (main probe)' };
  }

  /**
   * 通过 DeepSeek 侧边栏公开的“··· → 删除 → 删除该对话”流程删除会话。
   * 不调用内部 API，避免把 Provider 私有请求格式泄露到核心层；菜单 DOM 变化时只需更新本 Adapter。
   */
  private async deleteSessions(sessionRefs: string[]): Promise<{
    ok: boolean;
    deletedRefs: string[];
    missingRefs: string[];
    error?: string;
  }> {
    const refs = [...new Set(sessionRefs.filter((ref) => /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\//.test(ref)))];
    if (refs.length === 0) return { ok: true, deletedRefs: [], missingRefs: [] };
    if (refs.some((ref) => this.sameSession(ref, location.href))) await this.newChat();

    const deletedRefs: string[] = [];
    const missingRefs: string[] = [];
    for (const ref of refs) {
      const link = await this.findSessionLinkWithScroll(ref);
      if (!link) {
        missingRefs.push(ref);
        continue;
      }
      const action = link.querySelector<HTMLElement>('[role="button"]');
      if (!action) {
        missingRefs.push(ref);
        continue;
      }
      action.click();
      const option = await this.waitForVisibleText('.ds-dropdown-menu-option', /^(删除|Delete)$/i);
      if (!option) {
        missingRefs.push(ref);
        continue;
      }
      option.click();
      const confirm = await this.waitForVisibleText('button, [role="button"]', /^(删除该对话|Delete conversation|Delete)$/i);
      if (!confirm) {
        missingRefs.push(ref);
        continue;
      }
      confirm.click();
      if (await this.waitForSessionGone(ref)) deletedRefs.push(ref);
      else missingRefs.push(ref);
    }
    return {
      ok: missingRefs.length === 0,
      deletedRefs,
      missingRefs,
      error: missingRefs.length ? '部分会话未在当前侧边栏加载，未执行删除' : undefined,
    };
  }

  private sameSession(left: string, right: string): boolean {
    try { return new URL(left, location.href).pathname === new URL(right, location.href).pathname; }
    catch { return left === right; }
  }

  private findSessionLink(ref: string): HTMLAnchorElement | null {
    return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/a/chat/s/"]'))
      .find((link) => this.sameSession(ref, link.href)) ?? null;
  }

  private async findSessionLinkWithScroll(ref: string): Promise<HTMLAnchorElement | null> {
    const immediate = this.findSessionLink(ref);
    if (immediate) return immediate;
    const sidebar = Array.from(document.querySelectorAll<HTMLElement>('.ds-scroll-area--enabled'))
      .find((el) => el.querySelector('a[href*="/a/chat/s/"]') && el.scrollHeight > el.clientHeight + 20);
    if (!sidebar) return null;
    const originalTop = sidebar.scrollTop;
    for (let attempt = 0; attempt < 24; attempt++) {
      sidebar.scrollTop = Math.min(sidebar.scrollHeight, sidebar.scrollTop + Math.max(240, sidebar.clientHeight * 0.8));
      await wait(100);
      const found = this.findSessionLink(ref);
      if (found) return found;
      if (sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 4) break;
    }
    sidebar.scrollTop = originalTop;
    return null;
  }

  private findVisibleText(selector: string, pattern: RegExp): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => el.offsetParent !== null)
      .find((el) => pattern.test((el.textContent ?? '').trim())) ?? null;
  }

  private async waitForVisibleText(selector: string, pattern: RegExp, timeoutMs = 2_000): Promise<HTMLElement | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.findVisibleText(selector, pattern);
      if (found) return found;
      await wait(100);
    }
    return null;
  }

  private async waitForSessionGone(ref: string, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.findSessionLink(ref)) return true;
      await wait(150);
    }
    return !this.findSessionLink(ref);
  }
}
