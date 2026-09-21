/** Content Script 入口：注入防重，注册命令监听，上报适配器事件 */
import type { AdapterEvent } from '../../core/messaging';
import { DeepSeekAdapter } from './adapter';
import { isDeepSeekCommand, type DeepSeekCommand } from './messages';

declare global {
  interface Window {
    __lcwDeepSeekInjected?: boolean | string;
  }
}

// 修改 Content Script/探针协议时必须递增。扩展 reload 不会销毁已打开页面里的
// isolated world；版本号确保 runtime 按需注入时不会被旧防重标记拦截。
const CONTENT_SCRIPT_VERSION = 'deepseek-v5';

if (window.__lcwDeepSeekInjected !== CONTENT_SCRIPT_VERSION) {
  window.__lcwDeepSeekInjected = CONTENT_SCRIPT_VERSION;
  const documentToken = crypto.randomUUID();

  const emit = (e: AdapterEvent): void => {
    try {
      void chrome.runtime.sendMessage(e);
    } catch {
      // SW 未就绪时丢弃事件：引擎靠持久化状态 + 对账恢复，不依赖单次事件
    }
  };

  // manifest 的 world:"MAIN" 注入在本环境不生效，改用 <script> 标签注入。
  // Content Script 版本已负责防重；这里不复用旧 script 节点，确保扩展 reload 后
  // 新协议探针能够替换页面中仍存活的旧探针。
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('content/mainProbe.js');
  s.dataset.lcwProbe = CONTENT_SCRIPT_VERSION;
  s.onload = () => s.remove();
  (document.head ?? document.documentElement).appendChild(s);

  const adapter = new DeepSeekAdapter(emit);

  chrome.runtime.onMessage.addListener((msg: DeepSeekCommand, _sender, sendResponse) => {
    if (!isDeepSeekCommand(msg)) return false;
    // 探活必须同步回复，否则文档进入 BFCache 时异步响应端口会先被关闭。
    // URL + 文档令牌用于防止导航后的旧 content script 抢答。
    if (msg.type === 'ping') {
      sendResponse({ ok: true, url: location.href, documentToken });
      return false;
    }
    adapter
      .handle(msg)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true; // 异步响应
  });

  adapter.start();
  emit({ channel: 'adapter', type: 'ready' });
}
