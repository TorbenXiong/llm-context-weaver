/** MV3 Service Worker：串行路由事件；核心不接触 tabs、URL 或 Provider DOM 命令。 */
import { Engine, type EngineHost } from '../core/engine/engine';
import { isActive } from '../core/engine/stateMachine';
import { isAdapterEvent, isUiCommand } from '../core/messaging';
import { getActiveJobId, getJob } from '../core/storage/jobStore';
import { DeepSeekProviderHost } from '../providers/deepseek/runtime';

const provider = new DeepSeekProviderHost();
const host: EngineHost = {
  connect: (job) => provider.connect(job),
  prepare: (connectionId, unit) => provider.prepare(connectionId, unit),
  submit: (connectionId, marker, prompt) => provider.submit(connectionId, marker, prompt),
  inspect: (connectionId, unit) => provider.inspect(connectionId, unit),
  scheduleAlarm: (name, when) => { void chrome.alarms.create(name, { when }); },
  clearAlarm: (name) => { void chrome.alarms.clear(name); },
  log: (...args) => console.debug('[lcw]', ...args),
};
const engine = new Engine(host);

// SW 同一轮生命周期内也可能收到 alarm 与 content event；所有 mutation 串行化。
let mutationQueue: Promise<void> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function respond(operation: () => Promise<unknown>, sendResponse: (value: unknown) => void): boolean {
  void serialized(operation)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isUiCommand(message)) {
    switch (message.type) {
      case 'start': return respond(() => engine.startJob(message.jobId), sendResponse);
      case 'pause': return respond(() => engine.pause(message.jobId), sendResponse);
      case 'resume': return respond(() => engine.resume(message.jobId), sendResponse);
      case 'cancel': return respond(() => engine.cancel(message.jobId), sendResponse);
      case 'retryFailed': return respond(() => engine.retryFailed(message.jobId), sendResponse);
      case 'forceRetryCurrent': return respond(() => engine.forceRetryCurrent(message.jobId), sendResponse);
      case 'retryChunk': return respond(() => engine.retryChunk(message.jobId, message.index), sendResponse);
    }
  }
  if (isAdapterEvent(message) && sender.tab?.id != null) {
    const connectionId = String(sender.tab.id);
    switch (message.type) {
      case 'ready': return respond(() => engine.onAdapterReady(connectionId), sendResponse);
      case 'generationStart': return respond(() => engine.onGenerationStart(connectionId), sendResponse);
      case 'generationEnd': return respond(() => engine.onGenerationEnd(connectionId), sendResponse);
      case 'rateLimited': return respond(() => engine.onRateLimited(connectionId, message.detail ?? ''), sendResponse);
      case 'error': return respond(() => engine.onAdapterError(connectionId, message.detail ?? ''), sendResponse);
      case 'remoteRefChanged': return respond(() => engine.onRemoteRefChanged(connectionId, message.detail ?? ''), sendResponse);
    }
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => { void serialized(() => engine.onAlarm(alarm.name)); });
chrome.tabs.onRemoved.addListener((tabId) => {
  void serialized(async () => {
    const activeId = await getActiveJobId();
    if (!activeId) return;
    const job = await getJob(activeId);
    const connectionId = String(tabId);
    if (job && job.providerConnectionId === connectionId && isActive(job.status)) {
      await engine.onConnectionGone(activeId, connectionId);
    }
  });
});

chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') }); });
chrome.runtime.onInstalled.addListener(() => { void serialized(() => engine.resumeActive()); });
chrome.runtime.onStartup.addListener(() => { void serialized(() => engine.resumeActive()); });
void serialized(() => engine.resumeActive());
