/**
 * DeepSeek 页面 DOM 选择器集中地（2026-09 已对线上版本校准）。
 * 页面结构可能随版本调整：失效时只改这里，不要动适配器逻辑。
 * 所有列表按优先级降序，queryFirst/queryAll 取第一个有命中的选择器。
 * 注意：避免使用 :has(svg rect) 这类宽匹配——lottie 动画的 clipPath 内含 rect，会误命中。
 */
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

/** 虚拟滚动容器（长会话只渲染视口内消息，收集时需滚动加载） */
export const SCROLL_AREA_SELECTORS = [
  '.ds-scroll-area--enabled',
  '.ds-virtual-list',
  'main [class*="scroll"]',
  'main',
];

/** 限流提示特征文案（toast / 页面提示），命中后引擎进入退避等待 */
export const RATE_LIMIT_PATTERNS = [
  /操作(过于|太)频繁/,
  /发送(过于|太)频繁/,
  /请稍后再试/,
  /too many requests/i,
  /rate\s*limit/i,
  /try again later/i,
];

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