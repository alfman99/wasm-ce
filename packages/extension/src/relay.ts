import { BridgeError, type ErrorCode, isBridgeError, type PageAgentInfo } from '@wasmcheat/protocol';

/**
 * Relay that sits between the extension and the page agent.
 *
 * It runs in the isolated world so it can use `chrome.runtime`, while the agent lives in
 * the page's main world (the only place `WebAssembly` instances exist). Everything here is
 * pass-through: no memory access happens in the isolated world.
 */

const RELAY_FLAG = '__wasmcheatRelay__';
const RPC_TIMEOUT_MS = 60_000;
const CHANNEL_TIMEOUT_MS = 2_000;

interface PageAgentGlobal {
  __wasmcheatRelay__?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The page agent cannot build an extension URL itself, so every message it receives names the
 * worker-scope agent bundle; that is what lets it bootstrap workers created after this point.
 */
function resolveWorkerAgentUrl(): string {
  try {
    return chrome.runtime.getURL('worker-agent.js');
  } catch {
    return '';
  }
}

const WORKER_AGENT_URL = resolveWorkerAgentUrl();

/**
 * The page agent cannot build an extension URL, and it has to know one *before* the page's own
 * scripts run their first `new Worker(...)`. Messages are asynchronous and lose that race, so the
 * URL is also published synchronously on the document element at document_start, where the
 * MAIN-world agent reads it.
 */
export const AGENT_URL_ATTRIBUTE = 'data-wasmcheat-agent';

try {
  if (WORKER_AGENT_URL !== '') document.documentElement.setAttribute(AGENT_URL_ATTRIBUTE, WORKER_AGENT_URL);
} catch {
  // A document without a root element at this point is not ours to fix; messages still work.
}

if (!(window as unknown as PageAgentGlobal)[RELAY_FLAG]) {
  (window as unknown as PageAgentGlobal)[RELAY_FLAG] = true;

  let channelId: string | null = null;
  let nextId = 1;
  const pending = new Map<string, Pending>();
  const channelWaiters: Array<() => void> = [];

  function post(payload: Record<string, unknown>): void {
    window.postMessage({ source: 'wasmcheat-sw', ...payload, workerAgentUrl: WORKER_AGENT_URL }, '*');
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as
      | {
          source?: string;
          type?: string;
          channelId?: string;
          id?: string;
          result?: unknown;
          error?: unknown;
          event?: string;
          data?: unknown;
        }
      | null;
    if (!data || data.source !== 'wasmcheat-page') return;

    if ((data.type === 'hello' || data.type === 'ready') && data.channelId) {
      channelId = data.channelId;
      while (channelWaiters.length > 0) channelWaiters.shift()!();
      if (data.type === 'ready') announceAttachment(data.channelId);
      return;
    }

    if (data.type === 'event' && typeof data.event === 'string') {
      forwardEvent(data.event, data.data);
      return;
    }

    if (data.type === 'result' && typeof data.id === 'string') {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(asBridgeError(data.error));
      else entry.resolve(data.result);
    }
  });

  /**
   * The page answers with the plain shape a `postMessage` can carry, so the error has to be rebuilt
   * before it is passed on: a bare object would lose its code and be reported as INTERNAL.
   */
  function asBridgeError(error: unknown): BridgeError {
    const shape = error as { code?: string; message?: string; detail?: unknown } | null;
    return new BridgeError(
      (shape?.code as ErrorCode | undefined) ?? 'INTERNAL',
      shape?.message ?? 'the page agent reported an error without a message',
      shape?.detail,
    );
  }

  function announceAttachment(channel: string): void {
    try {
      chrome.runtime.sendMessage(
        { type: 'wasmcheat.relay-ready', channelId: channel, url: location.href },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // The extension was reloaded underneath this page; nothing to announce to.
    }
  }

  /**
   * Page events are a fire-and-forget push: nothing on this side waits for an answer, and a
   * dropped one only means a caller falls back to reading the status it asked about.
   */
  function forwardEvent(name: string, payload: unknown): void {
    try {
      chrome.runtime.sendMessage(
        { type: 'wasmcheat.event', event: name, data: payload, url: location.href },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // The extension was reloaded underneath this page; there is nobody to forward to.
    }
  }

  async function ensureChannel(): Promise<string> {
    if (channelId) return channelId;
    post({ type: 'ping' });
    await new Promise<void>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = channelWaiters.indexOf(waiter);
        if (index >= 0) channelWaiters.splice(index, 1);
        resolve();
      }, CHANNEL_TIMEOUT_MS);
      channelWaiters.push(waiter);
    });
    if (!channelId) {
      throw new BridgeError(
        'NO_AGENT',
        'the WasmCheat agent is not running in this page (reload the tab, or attach with reload=true)',
      );
    }
    return channelId;
  }

  async function call(method: string, params: unknown): Promise<unknown> {
    const channel = await ensureChannel();
    const id = String(nextId++);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError('TIMEOUT', `page did not answer ${method} within ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      post({ type: 'call', channelId: channel, id, method, params });
    });
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (value: unknown) => void) => {
    const msg = message as { type?: string; method?: string; params?: unknown } | null;
    if (!msg || msg.type !== 'wasmcheat.rpc' || typeof msg.method !== 'string') return undefined;
    call(msg.method, msg.params ?? {})
      .then((result) => sendResponse({ result }))
      .catch((error: unknown) => {
        sendResponse({
          error: isBridgeError(error)
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
        });
      });
    return true; // keep the channel open for the async answer
  });

  // Let the service worker know the agent is live on this page as early as possible.
  post({ type: 'ping' });
  void (async () => {
    try {
      const info = (await call('page.hello', {})) as PageAgentInfo;
      announceAttachment(channelId ?? info.version);
    } catch {
      // No agent in this page (for example a page that blocked the script); harmless.
    }
  })();
}
