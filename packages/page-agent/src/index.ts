import { BridgeError, isBridgeError, isWorkerMessage, jsonSafe, type WorkerType } from '@wasmcheat/protocol';
import { PageRuntime } from './runtime.js';
import { restoreTrace } from './trace.js';

/**
 * Entry point injected into the page's MAIN world.
 *
 * The agent has to live in the main world: `WebAssembly` instances only exist in the
 * realm that created them. That also means page scripts can see and spoof this channel
 * — unavoidable in principle — so the channel id only guards against cross-talk between
 * duplicate injections, and the real trust boundary is the extension's approval gate.
 *
 * WORKERS. A module instantiated inside a worker lives in the worker's realm, where this
 * script cannot see it. So once the relay tells us where `worker-agent.js` lives, `Worker`
 * is replaced by a wrapper that starts the worker from a blob which loads the worker agent
 * first and the page's own script second. The worker keeps its own `WasmRegistry` and
 * answers `page.*` calls over `postMessage`; this realm routes to it by id prefix (`k1-1`).
 */

const GLOBAL_KEY = '__wasmcheat__';
const AGENT_VERSION = '0.2.0';

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

/** Attribute the isolated-world relay publishes the worker bundle URL on, at document_start. */
const AGENT_URL_ATTRIBUTE = 'data-wasmcheat-agent';

/**
 * The wrapper is installed once, as soon as the document element exists, and resolves the bundle
 * URL at call time. Waiting for the relay's message loses the race against page scripts that
 * create a Worker during their own start-up, which is exactly what a game engine's loader does.
 */
let workerWrapperInstalled = false;

/** `k1`, `k2`… in construction order; the prefix every worker-owned id carries. */
let nextWorkerId = 1;

interface InstrumentedWorkerRecord {
  /** Worker id this realm assigned, e.g. `k1`. */
  id: string;
  /** The URL the page asked for, kept for `page.listWorkers`. */
  originalUrl: string;
  /** Blob holding the bootstrap, revoked once the worker has started. */
  blobUrl: string | null;
  blobReleased: boolean;
}

const instrumentedWorkers = new WeakMap<Worker, InstrumentedWorkerRecord>();

function post(payload: Record<string, unknown>): void {
  window.postMessage({ source: 'wasmcheat-page', ...payload }, '*');
}

/** Directory of the page: what a relative worker URL in the page would have resolved against. */
function pageBaseUrl(): string {
  try {
    return new URL('.', location.href).href;
  } catch {
    return '';
  }
}

/** A relative worker URL would resolve against the blob, which is not hierarchical. */
function absoluteUrl(url: string): string {
  return new URL(url, location.href).href;
}

function workerTypeOf(options?: WorkerOptions): WorkerType {
  return options?.type === 'module' ? 'module' : 'classic';
}

/**
 * The script every instrumented worker really runs.
 *
 * Classic workers run statements in order, so the id is set before either script loads. Module
 * workers evaluate their static imports *before* their own body, which would hand the agent an
 * id-less global, so the module case chains dynamic imports instead: id first, agent second, app
 * third. A rejected agent import must not take the app down with it.
 */
function bootstrapSource(id: string, agentUrl: string, originalUrl: string, type: WorkerType, baseUrl: string): string {
  // The agent URL travels with the id: a worker that spawns another worker installs the wrapper in
  // its own global, and it needs the URL to bootstrap the child the same way. The base URL travels
  // too, because a blob worker's own `location.href` is `blob:…`, against which a relative script
  // path cannot be resolved.
  const prologue =
    `self.__wasmcheatWorkerId = ${JSON.stringify(id)};\n` +
    `self.__wasmcheatAgentUrl = ${JSON.stringify(agentUrl)};\n` +
    `self.__wasmcheatBaseUrl = ${JSON.stringify(baseUrl)};\n`;
  const agent = JSON.stringify(agentUrl);
  const original = JSON.stringify(originalUrl);
  if (type === 'module') {
    return `${prologue}import(${agent}).catch(() => {}).then(() => import(${original}));\n`;
  }
  return `${prologue}try { importScripts(${agent}); } catch (error) {}\nimportScripts(${original});\n`;
}

function releaseBlob(record: InstrumentedWorkerRecord): void {
  if (record.blobUrl === null || record.blobReleased) return;
  record.blobReleased = true;
  URL.revokeObjectURL(record.blobUrl);
}

function instrumentWorker(
  runtime: PageRuntime,
  // Captured once, when the wrapper is installed. Reading `window.Worker` here would read the
  // wrapper itself and recurse until the stack dies.
  RealWorker: typeof Worker,
  agentUrl: string,
  scriptURL: string | URL,
  options?: WorkerOptions,
): Worker {
  // No URL yet means no way to bootstrap the worker agent; run the worker as the page asked and
  // stay out of its way rather than replacing it with a blob that cannot import the agent.
  if (agentUrl === '') return new RealWorker(scriptURL, options);
  const id = `k${nextWorkerId++}`;
  const originalUrl = absoluteUrl(typeof scriptURL === 'string' ? scriptURL : scriptURL.href);
  const type = workerTypeOf(options);
  const record: InstrumentedWorkerRecord = { id, originalUrl, blobUrl: null, blobReleased: false };

  let worker: Worker | null = null;
  try {
    record.blobUrl = URL.createObjectURL(
      new Blob([bootstrapSource(id, agentUrl, originalUrl, type, pageBaseUrl())], { type: 'text/javascript' }),
    );
    worker = new RealWorker(record.blobUrl, options);
  } catch {
    // A CSP without `worker-src blob:`, or a URL the blob cannot import: run the worker as the
    // page asked for it. It stays uninstrumented rather than breaking the page.
    releaseBlob(record);
    record.blobUrl = null;
    worker = null;
  }
  if (worker === null) return new RealWorker(originalUrl, options);

  const started = worker;
  instrumentedWorkers.set(started, record);
  started.addEventListener('message', (event: MessageEvent) => {
    // First message proves both bootstrap scripts ran, so the blob is no longer needed.
    releaseBlob(record);
    if (isWorkerMessage(event.data)) runtime.handleWorkerMessage(record.id, event.data);
  });
  started.addEventListener('error', () => releaseBlob(record));

  const terminate = started.terminate.bind(started);
  started.terminate = () => {
    runtime.removeWorker(record.id);
    releaseBlob(record);
    terminate();
  };

  runtime.addWorker({
    id: record.id,
    url: originalUrl,
    type,
    post: (message) => started.postMessage(message),
  });
  return started;
}

/** Replaces `Worker` so that every worker created from here on also runs the worker agent. */
function installWorkerWrapper(runtime: PageRuntime, resolveUrl: () => string): void {
  if (workerWrapperInstalled || typeof window.Worker !== 'function') return;
  workerWrapperInstalled = true;
  const RealWorker = window.Worker;

  // Not a subclass: a blob worker that the CSP rejects has to be retried as a plain worker, and a
  // constructor cannot call `super` twice. Returning a real Worker instance keeps `postMessage`,
  // `terminate`, `onmessage` and `instanceof Worker` exactly as the page expects.
  function InstrumentedWorker(this: unknown, scriptURL: string | URL, options?: WorkerOptions): Worker {
    return instrumentWorker(runtime, RealWorker, resolveUrl(), scriptURL, options);
  }

  InstrumentedWorker.prototype = RealWorker.prototype;
  window.Worker = InstrumentedWorker as unknown as typeof Worker;
}

async function answer(
  runtime: PageRuntime,
  channelId: string,
  id: string,
  method: string,
  params: unknown,
): Promise<void> {
  let result: unknown;
  let error: unknown;
  try {
    result = jsonSafe(await runtime.handle(method, params));
  } catch (thrown) {
    // Send the plain shape, never the Error instance: `postMessage` clones an Error's name and
    // message but drops custom properties, so a BridgeError would arrive without its `code`.
    error = isBridgeError(thrown)
      ? { code: thrown.code, message: thrown.message, detail: (thrown as { detail?: unknown }).detail }
      : new BridgeError('INTERNAL', thrown instanceof Error ? thrown.message : String(thrown)).toJSON();
  }
  post({ type: 'result', channelId, id, result, error });
}

/**
 * Reads the URL the relay published on the document element. Falls back to an empty string when the
 * relay is not there (a page the extension only injected dynamically), in which case workers run
 * uninstrumented instead of breaking.
 */
function agentUrlFromDocument(): string {
  try {
    return document.documentElement?.getAttribute(AGENT_URL_ATTRIBUTE) ?? '';
  } catch {
    return '';
  }
}

function main(): void {
  if (window[GLOBAL_KEY]) {
    // Already injected (dynamic script + late injection can both fire). The existing
    // agent answers pings, so the relay simply re-links to it.
    return;
  }

  const runtime = new PageRuntime();
  runtime.install();
  // Before the page's first line: a game that grabs `performance.now` at load must already be wrapped.
  runtime.speed.install();
  // A watchpoint armed before the reload is re-armed here, before the app's scripts run.
  restoreTrace(runtime.trace);

  // Install the Worker wrapper now, not when the first message arrives: the app's loader may create
  // its worker in the same document_start batch, and a worker created before the wrapper exists is
  // invisible forever. The URL is resolved per construction so a later message can fill it in.
  let workerAgentUrl = agentUrlFromDocument();
  installWorkerWrapper(runtime, () => workerAgentUrl || agentUrlFromDocument());

  const agent: AgentGlobal = {
    version: AGENT_VERSION,
    channelId: runtime.channelId,
    runtime,
  };
  window[GLOBAL_KEY] = agent;

  // Watchpoint hits arrive while the page runs, so they are pushed to the bridge as they happen.
  // A caller that is waiting for the first hit then needs no polling, and a caller that is not
  // waiting loses nothing: `page.trace.status` still holds the same list.
  runtime.onEvent((event, data) => {
    post({ type: 'event', channelId: agent.channelId, event, data: jsonSafe(data) });
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as
      | {
          source?: string;
          type?: string;
          channelId?: string;
          id?: string;
          method?: string;
          params?: unknown;
          workerAgentUrl?: string;
        }
      | null;
    if (!data || data.source !== 'wasmcheat-sw') return;

    // The relay is the only party that can resolve an extension URL, so it names the worker agent.
    if (typeof data.workerAgentUrl === 'string' && data.workerAgentUrl !== '') {
      workerAgentUrl = data.workerAgentUrl;
      installWorkerWrapper(runtime, () => workerAgentUrl || agentUrlFromDocument());
    }

    if (data.type === 'ping') {
      post({ type: 'hello', channelId: agent.channelId, info: runtime.info() });
      return;
    }
    if (data.channelId !== agent.channelId) return;
    if (data.type !== 'call' || typeof data.id !== 'string') return;

    void answer(runtime, agent.channelId, data.id, data.method ?? '', data.params ?? {});
  });

  post({ type: 'ready', channelId: agent.channelId, info: runtime.info() });
}

main();
