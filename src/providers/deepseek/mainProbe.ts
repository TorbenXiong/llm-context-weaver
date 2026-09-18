/**
 * MAIN world 探针。DeepSeek 的回复(.ds-markdown)渲染在主世界，
 * content script 的 isolated world 里 querySelector 看不到，
 * 因此把 DOM 读取放到这里，通过 window.postMessage 与 content script 桥接。
 * 只做只读查询与滚动，不碰 chrome.* API。
 */
export {};

import { selectLastReplyText } from './replySelection';

declare global {
  interface Window {
    __lcwMainProbe?: boolean;
  }
}

(() => {
  if (window.__lcwMainProbe) return;
  window.__lcwMainProbe = true;

  const MARKDOWN_SELECTORS = ['.ds-markdown', '.ds-assistant-message-main-content', '[class*="markdown-body"]'];
  const SCROLL_SELECTORS = ['.ds-scroll-area--enabled', '.ds-virtual-list', 'main [class*="scroll"]', 'main'];
  const GENERATING_SELECTORS = ['div[role="button"].ds-button--primary:has(svg rect)', '[aria-label*="停止"]', '[aria-label*="stop" i]'];

  const q = (sels: string[]): Element[] => {
    for (const s of sels) {
      try {
        const els = Array.from(document.querySelectorAll(s));
        if (els.length > 0) return els;
      } catch { /* skip */ }
    }
    return [];
  };
  const q1 = (sels: string[]): Element | null => q(sels)[0] ?? null;

  /** 不用 createTreeWalker（部分环境被禁用），遍历叶子元素匹配 marker 文本 */
  function findMarkerEl(marker: string): Element | null {
    let found: Element | null = null;
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const t = el.textContent ?? '';
      if (!t.includes(marker)) continue;
      // 叶子级命中（子元素里没有再包含 marker 的）
      const childHas = Array.from(el.children).some((c) => (c.textContent ?? '').includes(marker));
      if (!childHas) found = el;
    }
    return found;
  }

  function readReply(marker: string): { found: boolean; text?: string } {
    const FOLLOWING = 4;
    const mdEls = q(MARKDOWN_SELECTORS);
    const markerEl = findMarkerEl(marker);
    if (mdEls.length === 0) return { found: false };
    const text = selectLastReplyText(mdEls.map((md) => ({
      followsMarker: markerEl ? (markerEl.compareDocumentPosition(md) & FOLLOWING) !== 0 : false,
      isThinking: md.closest('.ds-think-content') !== null,
      text: md.textContent || '',
    })));
    if (text) return { found: true, text };

    // 虚拟列表可能暂时把用户提示和助手回复放在不同的可见片段中，
    // 此时 compareDocumentPosition 无法建立“回复跟随 marker”的关系。
    // 独立对话模式下 marker 是本次请求的唯一标识；确认 marker 仍在页面后，
    // 退化为读取最后一条非思考回复，避免把已完成结果误判为 missing。
    if (document.body?.innerText.includes(marker)) {
      for (let index = mdEls.length - 1; index >= 0; index--) {
        const md = mdEls[index];
        if (md?.closest('.ds-think-content') || !md) continue;
        const fallback = (md.textContent || '').trim();
        if (fallback) return { found: true, text: fallback };
      }
    }
    return { found: false };
  }

  function scrollUp() {
    const s = q1(SCROLL_SELECTORS);
    if (s && s.scrollTop > 0) {
      s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight * 1.5);
      return true;
    }
    return false;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lcwReq == null) return;
    const { __lcwReq, action, marker } = e.data;
    let payload;
    try {
      if (action === 'readReply') payload = readReply(marker);
      else if (action === 'hasMarker') payload = { has: document.body.innerText.includes(marker) };
      else if (action === 'isGenerating') payload = { generating: !!q1(GENERATING_SELECTORS) };
      else if (action === 'scrollUp') payload = { scrolled: scrollUp() };
      else if (action === 'mdCount') payload = { count: q(MARKDOWN_SELECTORS).length };
      else payload = { error: 'unknown action' };
    } catch (err) {
      payload = { error: String(err) };
    }
    window.postMessage({ __lcwRes: __lcwReq, ...payload }, '*');
  });
})();
