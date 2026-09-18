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
import type { DeepSeekCommand } from './messages';
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

  private reqId = 0;

  constructor(private readonly emit: (e: AdapterEvent) => void) {}

  /** 与 MAIN world 探针桥接（content script 的 isolated world 看不到主世界渲染的 .ds-markdown） */
  private callMainProbe<T extends Record<string, unknown>>(action: string, extra: Record<string, unknown> = {}, timeoutMs = 4_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('mainProbe 无响应'));
      }, timeoutMs);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== window || !e.data || (e.data as { __lcwRes?: number }).__lcwRes !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(e.data as T);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ __lcwReq: id, action, ...extra }, '*');
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
        return { ok: true };
      case 'status': {
        if (!this.findInput()) return { state: 'unknown' };
        const gen = await this.isGenerating();
        return { state: gen ? 'generating' : 'idle' };
      }
      case 'newChat':
        return this.newChat();
      case 'hasMarker':
        return this.callMainProbe('hasMarker', { marker: cmd.marker });
      case 'sendPrompt':
        return this.sendPrompt(cmd.text);
      case 'readReply':
        return this.readReply(cmd.marker);
      default:
        return { ok: false, error: 'unknown command' };
    }
  }

  private findInput(): HTMLTextAreaElement | null {
    const el = queryFirst(INPUT_SELECTORS);
    return el instanceof HTMLTextAreaElement ? el : null;
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
              this.emit({ channel: 'adapter', type: 'rateLimited', detail: String(pattern) });
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
    outcome: 'accepted' | 'rejected' | 'retryable' | 'ambiguous';
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
        return { outcome: 'ambiguous', url, error: '点击发送后未观察到输入框清空、生成开始或会话 URL 变化' };
      }
      await wait(100);
    }
    return { outcome: 'rejected', error: '发送按钮不可用' };
  }

  private async waitForSubmissionConfirmation(
    originalText: string,
    timeoutMs: number,
  ): Promise<{ outcome: 'accepted' | 'retryable' | 'ambiguous'; url: string | null; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let acceptedAt: number | null = null;
    while (Date.now() < deadline) {
      const url = location.pathname.startsWith('/a/chat/') ? location.href : null;
      const bodyText = document.body?.innerText ?? '';
      if (bodyText.includes('有消息正在生成，请稍后再试')) {
        return { outcome: 'retryable', url, error: 'DeepSeek 仍有消息正在生成' };
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
  private async readReply(marker: string): Promise<{ found: boolean; text?: string; error?: string }> {
    for (let round = 0; round < 5; round++) {
      try {
        const r = await this.callMainProbe<{ found?: boolean; text?: string }>('readReply', { marker });
        if (
          r.found === true &&
          typeof r.text === 'string' &&
          r.text.trim().length > 0 &&
          hasCompleteJsonObject(r.text)
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
}
