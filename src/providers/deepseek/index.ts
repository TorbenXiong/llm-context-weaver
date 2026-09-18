/** Content Script 入口：注入防重，注册命令监听，上报适配器事件 */
import type { AdapterEvent } from '../../core/messaging';
import { DeepSeekAdapter } from './adapter';
import { isDeepSeekCommand, type DeepSeekCommand } from './messages';

declare global {
  interface Window {
    __lcwDeepSeekInjected?: boolean;
  }
}

if (!window.__lcwDeepSeekInjected) {
  window.__lcwDeepSeekInjected = true;

  const emit = (e: AdapterEvent): void => {
    try {
      void chrome.runtime.sendMessage(e);
    } catch {
      // SW 未就绪时丢弃事件：引擎靠持久化状态 + 对账恢复，不依赖单次事件
    }
  };

  // manifest 的 world:"MAIN" 注入在本环境不生效，改用 <script> 标签兜底注入 MAIN world 探针
  if (!document.querySelector('script[data-lcw-probe]')) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/mainProbe.js');
    s.dataset.lcwProbe = '1';
    s.onload = () => s.remove();
    (document.head ?? document.documentElement).appendChild(s);
  }

  const adapter = new DeepSeekAdapter(emit);

  chrome.runtime.onMessage.addListener((msg: DeepSeekCommand, _sender, sendResponse) => {
    if (!isDeepSeekCommand(msg)) return false;
    adapter
      .handle(msg)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true; // 异步响应
  });

  adapter.start();
  emit({ channel: 'adapter', type: 'ready' });
}
