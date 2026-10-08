/**
 * DeepSeek 页面 DOM 选择器集中地（2026-09 已对线上版本校准）。
 * 页面结构可能随版本调整：失效时只改这里，不要动适配器逻辑。
 * 所有列表按优先级降序，queryFirst/queryAll 取第一个有命中的选择器。
 * 注意：避免使用 :has(svg rect) 这类宽匹配——lottie 动画的 clipPath 内含 rect，会误命中。
 */
import { isDeepSeekConversationLimitText } from './contextLimit';

export const INPUT_SELECTORS = [
  'textarea[placeholder*="发送"]',
  'textarea[placeholder*="DeepSeek" i]',
  'textarea#chat-input',
  'textarea[placeholder*="message" i]',
  'textarea',
];

/** 发送按钮：设计系统类 ds-button--primary + 圆形；禁用时带 ds-button--disabled */
export const SEND_BUTTON_SELECTORS = [
  'div[role="button"].ds-button--primary.ds-button--circle',
  'div[role="button"].ds-icon-button',
  'button[type="submit"]',
];

export const SEND_BUTTON_DISABLED_CLASS = 'ds-button--disabled';

/** 生成中的特征：发送按钮变为停止按钮（主按钮内含方形 rect）。待真机复核。 */
export const GENERATING_SELECTORS = [
  'div[role="button"].ds-button--primary:has(svg rect)',
  '[aria-label*="停止"]',
  '[aria-label*="stop" i]',
];

export const MARKDOWN_SELECTORS = [
  '.ds-markdown',
  '.ds-assistant-message-main-content',
  '[class*="markdown-body"]',
];

/** 新对话入口：左上角"开启新对话"按钮（aria-label / 文本双通道） */
export const NEW_CHAT_SELECTORS = [
  '[aria-label*="开启新对话"]',
  '[aria-label*="new chat" i]',
  'a[href="/"]',
];

/** 侧栏账号入口的昵称节点；不要使用侧栏/按钮全页扫描，会话标题也可能含手机号。 */
export const ACCOUNT_LABEL_SELECTORS = [
  '._2afd28d[tabindex="0"] ._9d8da05',
];

export const ACCOUNT_EXCLUDED_REGIONS =
  'a, [class*="scroll" i], .ds-message, .ds-markdown, main, textarea, input, [contenteditable="true"]';

/** 虚拟滚动容器（长会话只渲染视口内消息，收集时需滚动加载） */
export const SCROLL_AREA_SELECTORS = [
  '.ds-scroll-area--enabled',
  '.ds-virtual-list',
  'main [class*="scroll"]',
  'main',
];

/** 限流提示特征文案（toast / 页面提示），命中后引擎进入退避等待 */
export const RATE_LIMIT_PATTERNS = [
  /消息发送过于频繁/,
  /操作(过于|太)频繁/,
  /发送(过于|太)频繁/,
  /too many requests/i,
  /rate\s*limit/i,
  /try again later/i,
];

/** 通知容器与消息行错误分开识别，避免把用户输入或模型正文当成官方提示。 */
export const NOTICE_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '[class*="toast" i]',
  '[class*="notification" i]',
  '[data-sonner-toast]',
];

export function isRateLimitNoticeText(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text.replace(/\s+/g, ' ').trim()));
}

/** 发送被拒时，DeepSeek 会把错误放在最新用户消息的正文外，且不赋予 alert/toast 语义。 */
function findInlineNotice(root: ParentNode, matches: (text: string) => boolean): string | null {
  const items = root.querySelectorAll<HTMLElement>('[data-virtual-list-item-key]');
  const latest = Array.from(items).filter((item) => item.querySelector('.ds-message')).at(-1);
  if (!latest) return null;
  for (const node of latest.querySelectorAll<HTMLElement>('span, p, div')) {
    if (node.children.length > 0 || node.closest('.ds-message, .ds-markdown, textarea, input, [contenteditable="true"]') || !node.getClientRects().length) continue;
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length <= 500 && matches(text)) return text;
  }
  return null;
}

function findNotice(root: ParentNode, matches: (text: string) => boolean): string | null {
  for (const selector of NOTICE_SELECTORS) {
    for (const node of root.querySelectorAll<HTMLElement>(selector)) {
      if (!node.getClientRects().length || node.closest('.ds-message, .ds-markdown, textarea, input, [contenteditable="true"]')) continue;
      // 通知通常很短；长正文即使碰巧使用了相同 class，也不应当作限流。
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length <= 500 && matches(text)) return text;
    }
  }
  return findInlineNotice(root, matches);
}

export const findInlineRateLimitNotice = (root: ParentNode = document): string | null =>
  findInlineNotice(root, (text) => text.length <= 160 && isRateLimitNoticeText(text));

export const findRateLimitNotice = (root: ParentNode = document): string | null =>
  findNotice(root, (text) => text.length <= 160 && isRateLimitNoticeText(text));

export const findConversationLimitNotice = (root: ParentNode = document): string | null =>
  findNotice(root, isDeepSeekConversationLimitText);

export function queryFirst(selectors: string[], root: ParentNode = document): Element | null {
  for (const s of selectors) {
    try {
      const el = root.querySelector(s);
      if (el) return el;
    } catch {
      // 非法选择器跳过
    }
  }
  return null;
}

export function queryAll(selectors: string[], root: ParentNode = document): Element[] {
  for (const s of selectors) {
    try {
      const els = Array.from(root.querySelectorAll(s));
      if (els.length > 0) return els;
    } catch {
      // 非法选择器跳过
    }
  }
  return [];
}
