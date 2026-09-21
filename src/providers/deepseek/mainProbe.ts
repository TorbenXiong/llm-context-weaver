/**
 * MAIN world 探针。DeepSeek 的回复(.ds-markdown)渲染在主世界，
 * content script 的 isolated world 里 querySelector 看不到，
 * 因此把 DOM 读取放到这里，通过 window.postMessage 与 content script 桥接。
 * 只做只读查询与滚动，不碰 chrome.* API。
 */
export {};

import { selectLastReplyText } from './replySelection';
import type { DeepSeekContinuationResult } from './messages';

declare global {
  interface Window {
    __lcwMainProbe?: boolean | string;
  }
}

(() => {
  const PROBE_VERSION = 'deepseek-probe-v5';
  const REQUEST_KEY = '__lcwReqV5';
  const RESPONSE_KEY = '__lcwResV5';
  if (window.__lcwMainProbe === PROBE_VERSION) return;
  window.__lcwMainProbe = PROBE_VERSION;

  const MARKDOWN_SELECTORS = ['.ds-markdown', '.ds-assistant-message-main-content', '[class*="markdown-body"]'];
  const SCROLL_SELECTORS = ['.ds-scroll-area--enabled', '.ds-virtual-list', 'main [class*="scroll"]', 'main'];
  const GENERATING_SELECTORS = ['div[role="button"].ds-button--primary:has(svg rect)', '[aria-label*="停止"]', '[aria-label*="stop" i]'];
  let lastContinueMarker = '';
  let lastContinueAt = 0;

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

  /**
   * DeepSeek 会在回复完成后保留隐藏的停止按钮节点。
   * 生成状态必须只依据当前可见、可布局的控件，避免把历史/隐藏节点
   * 误判为仍在生成，进而永远不收集已经完成的回复。
   */
  const isVisible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return el.getClientRects().length > 0;
  };

  /** 发送按钮在回复结束后仍可能保持可见，但会带 disabled 状态。 */
  const isDisabledControl = (el: Element): boolean =>
    el.getAttribute('aria-disabled') === 'true' ||
    el.hasAttribute('disabled') ||
    el.classList.contains('ds-button--disabled');

  const hasVisibleMatch = (sels: string[]): boolean => {
    for (const selector of sels) {
      try {
        if (Array.from(document.querySelectorAll(selector)).some((el) => isVisible(el) && !isDisabledControl(el))) return true;
      } catch { /* skip invalid selectors */ }
    }
    return false;
  };

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

  /**
   * DeepSeek 在回复触及单次输出上限时会显示“继续生成”。只在当前任务 marker
   * 之后查找并点击，避免误触其他历史回复上的同名按钮。长回复进入虚拟列表后，
   * marker 对应的 DOM 节点可能已经被回收；此时在当前任务独占的 Provider 页面中
   * 选择最后一个可见的继续按钮作为兜底，避免把“已达到输出上限”误判为 idle。
   */
  function visibleContinueButtons(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .filter((el) => {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!/^(继续生成|Continue generating|Continue generation|Continue)$/i.test(text)) return false;
        if (!isVisible(el)) return false;
        if (isDisabledControl(el)) return false;
        return true;
      });
  }

  function replyTextLength(): number {
    return q(MARKDOWN_SELECTORS).reduce((total, el) => total + (el.textContent ?? '').length, 0);
  }

  function dispatchPointerClick(button: HTMLElement): void {
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.focus({ preventScroll: true });
    const rect = button.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const pointer = (type: string, buttons: number): void => {
      button.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX,
        clientY,
      }));
    };
    const mouse = (type: string, buttons: number): void => {
      button.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons,
        clientX,
        clientY,
      }));
    };
    pointer('pointerover', 0);
    mouse('mouseover', 0);
    pointer('pointerdown', 1);
    mouse('mousedown', 1);
    pointer('pointerup', 0);
    mouse('mouseup', 0);
    mouse('click', 0);
  }

  async function clickContinueGeneration(marker: string): Promise<DeepSeekContinuationResult> {
    const markerEl = findMarkerEl(marker);
    const FOLLOWING = 4;
    const candidates = visibleContinueButtons();
    const afterMarker = markerEl
      ? candidates.filter((el) => (markerEl.compareDocumentPosition(el) & FOLLOWING) !== 0)
      : [];
    // 虚拟滚动会让 markerEl 暂时脱离 DOM，或者 marker 与按钮位于不同的渲染片段，
    // 导致 compareDocumentPosition 无法建立关系。当前 Provider 标签页一次只处理一个
    // 工作单元，因此最后一个可见按钮是安全的兜底目标。
    const button = (afterMarker.length > 0 ? afterMarker : candidates).at(-1);
    if (!button) return { found: false, attempted: false, confirmed: false };
    if (lastContinueMarker === marker && Date.now() - lastContinueAt < 3_000) {
      return {
        found: true,
        attempted: false,
        confirmed: false,
        evidence: 'not_confirmed',
        detail: '距离上次续写尝试不足 3 秒',
      };
    }
    const beforeReplyLength = replyTextLength();
    dispatchPointerClick(button);
    lastContinueMarker = marker;
    lastContinueAt = Date.now();
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const remaining = visibleContinueButtons();
      if (remaining.length === 0) {
        return { found: true, attempted: true, confirmed: true, evidence: 'button_disappeared' };
      }
      if (remaining.every(isDisabledControl)) {
        return { found: true, attempted: true, confirmed: true, evidence: 'button_disabled' };
      }
      if (hasVisibleMatch(GENERATING_SELECTORS)) {
        return { found: true, attempted: true, confirmed: true, evidence: 'generating' };
      }
      if (replyTextLength() > beforeReplyLength) {
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

  function scrollUp() {
    const s = q1(SCROLL_SELECTORS);
    if (s && s.scrollTop > 0) {
      s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight * 1.5);
      return true;
    }
    return false;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[REQUEST_KEY] == null) return;
    const requestId = e.data[REQUEST_KEY];
    const { action, marker } = e.data;
    void (async () => {
      let payload;
      try {
        if (action === 'readReply') payload = readReply(marker);
        else if (action === 'continueGeneration') payload = await clickContinueGeneration(marker);
        else if (action === 'hasMarker') payload = { has: document.body.innerText.includes(marker) };
        else if (action === 'isGenerating') payload = { generating: hasVisibleMatch(GENERATING_SELECTORS) };
        else if (action === 'scrollUp') payload = { scrolled: scrollUp() };
        else if (action === 'mdCount') payload = { count: q(MARKDOWN_SELECTORS).length };
        else payload = { error: 'unknown action' };
      } catch (err) {
        payload = { error: String(err) };
      }
      window.postMessage({ [RESPONSE_KEY]: requestId, ...payload }, '*');
    })();
  });
})();
