import { BridgeError, isBridgeError, jsonSafe } from '@wasmcheat/protocol';
import { PageRuntime } from './runtime.js';

/**
 * Entry point injected into the page's MAIN world.
 *
 * The agent has to live in the main world: `WebAssembly` instances only exist in the
 * realm that created them. That also means page scripts can see and spoof this channel
 * — unavoidable in principle — so the channel id only guards against cross-talk between
 * duplicate injections, and the real trust boundary is the extension's approval gate.
 */

const GLOBAL_KEY = '__wasmcheat__';
const AGENT_VERSION = '0.1.0';

interface AgentGlobal {
  version: string;
  channelId: string;
  runtime: PageRuntime;
}

declare global {
  interface Window {
    [GLOBAL_KEY]?: AgentGlobal;
  }
}

function post(payload: Record<string, unknown>): void {
  window.postMessage({ source: 'wasmcheat-page', ...payload }, '*');
}

function main(): void {
  if (window[GLOBAL_KEY]) {
    // Already injected (dynamic script + late injection can both fire). The existing
    // agent answers pings, so the relay simply re-links to it.
    return;
  }

  const runtime = new PageRuntime();
  runtime.install();

  const agent: AgentGlobal = {
    version: AGENT_VERSION,
    channelId: runtime.channelId,
    runtime,
  };
  window[GLOBAL_KEY] = agent;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as
      | { source?: string; type?: string; channelId?: string; id?: string; method?: string; params?: unknown }
      | null;
    if (!data || data.source !== 'wasmcheat-sw') return;

    if (data.type === 'ping') {
      post({ type: 'hello', channelId: agent.channelId, info: runtime.info() });
      return;
    }
    if (data.channelId !== agent.channelId) return;
    if (data.type !== 'call' || typeof data.id !== 'string') return;

    let result: unknown;
    let error: unknown;
    try {
      result = jsonSafe(runtime.handle(data.method ?? '', data.params ?? {}));
    } catch (thrown) {
      error = isBridgeError(thrown)
        ? thrown
        : new BridgeError('INTERNAL', thrown instanceof Error ? thrown.message : String(thrown)).toJSON();
    }
    post({ type: 'result', channelId: agent.channelId, id: data.id, result, error });
  });

  post({ type: 'ready', channelId: agent.channelId, info: runtime.info() });
}

main();
