import {
  BridgeError,
  isBridgeError,
  isWorkerMessage,
  jsonSafe,
  type BridgeErrorShape,
  type WorkerAgentInfo,
  type WorkerMessage,
} from '@wasmcheat/protocol';
import { PageRuntime } from './runtime.js';

/**
 * Agent that runs inside a Worker global instead of a document.
 *
 * Unity, Godot 4 and most itch.io builds compile and instantiate their module in a worker, where
 * the page realm's `WebAssembly` hook never sees it. This bundle is the same `PageRuntime` with no
 * DOM, driven by the page agent over `postMessage`:
 *
 *   page  -> worker   {__wasmcheat: 'hello'}                       probe, answered before any instance
 *   worker -> page    {__wasmcheat: 'hello', info}                 instance count, version, url
 *   page  -> worker   {__wasmcheat: 'call', id, method, params}    any `page.*` method
 *   worker -> page    {__wasmcheat: 'result', id, result, error}   the same shape the relay uses
 *
 * IDS. A document and its workers each mint their own ids, so every id a worker names carries the
 * worker's page-assigned id as a prefix: instances `k1-1`, `k1-2`, scans `k1-s1`, freezes `k1-f1`,
 * watches `k1-v1`, hooks `k1-h1`. Inside the worker those are the plain `w1`/`s1`/`f1` the stores
 * mint; the prefix is added on the way out and stripped on the way in, so the routing rule on the
 * page side is exactly "everything before the first dash". An id with no dash belongs to the page
 * realm, which is why page ids (`w1`, `s1`) still mean what they always meant.
 *
 * LIMITS. A worker created before the page agent learned the URL of this bundle is never
 * bootstrapped; a worker created inside a worker (nested) never goes through the page's wrapper;
 * a cross-origin worker URL cannot be constructed at all; and a page whose CSP forbids blob
 * workers keeps working but stays invisible. Agent traffic shares the worker's message port, so
 * the app's own `onmessage` sees the tagged messages above and vice versa.
 */

/** Used when the blob bootstrap did not set the id, i.e. this bundle was loaded some other way. */
const FALLBACK_WORKER_ID = 'k0';

/** Fields that hold an instance id, a formatted address (`w1:0x10`) or a session id. */
const ID_KEYS = new Set([
  'id',
  'instanceId',
  'scanId',
  'freezeId',
  'watchId',
  'hookId',
  'patchId',
  'address',
  'final',
  'base',
  'target',
]);

/** The subset of `DedicatedWorkerGlobalScope` this agent needs. */
interface WorkerScope {
  __wasmcheatWorkerId?: unknown;
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface WorkerAgentOptions {
  /** Id the page agent assigned at construction, e.g. `k1`. */
  workerId: string;
  post(message: WorkerMessage): void;
}

export class WorkerAgent {
  readonly runtime: PageRuntime;
  private readonly workerId: string;
  private readonly post: (message: WorkerMessage) => void;

  constructor(options: WorkerAgentOptions) {
    this.workerId = options.workerId;
    this.post = options.post;
    this.runtime = new PageRuntime({ realm: 'worker', workerId: this.workerId });
    this.runtime.install();
  }

  /** Answered even with no instance yet: the page probes every worker at attach time. */
  hello(): WorkerAgentInfo {
    return { ...this.runtime.info(), instances: this.runtime.registry.list().length };
  }

  async handleMessage(data: unknown): Promise<void> {
    if (!isWorkerMessage(data)) return;
    if (data.__wasmcheat === 'hello') {
      this.post({ __wasmcheat: 'hello', info: this.hello() });
      return;
    }
    if (data.__wasmcheat !== 'call') return;

    let result: unknown;
    let error: BridgeErrorShape | undefined;
    try {
      const answer = await this.runtime.handle(data.method, mapIds(data.params, (id) => localizeId(id, this.workerId)));
      result = jsonSafe(mapIds(answer, (id) => externalizeId(id, this.workerId)));
    } catch (thrown) {
      const bridge = isBridgeError(thrown)
        ? thrown
        : new BridgeError('INTERNAL', thrown instanceof Error ? thrown.message : String(thrown)).toJSON();
      // Errors from this realm name its own ids (`w9`); the caller only knows `k1-9`.
      error = { ...bridge, message: externalizeIdsInText(bridge.message, this.workerId) };
    }
    this.post({ __wasmcheat: 'result', id: data.id, result, error });
  }
}

/**
 * Rewrites the id-bearing fields of a message payload in place-free fashion: everything is walked,
 * but only strings under the keys that hold ids are touched, so hook bodies and export names keep
 * whatever they contain.
 */
function mapIds(value: unknown, mapId: (id: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapIds(item, mapId));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === 'object') out[key] = mapIds(item, mapId);
    else if (typeof item === 'string' && ID_KEYS.has(key)) out[key] = mapId(item);
    else out[key] = item;
  }
  return out;
}

/** `k1-1` -> `w1`, `k1-1:0x10` -> `w1:0x10`, `k1-s1` -> `s1`; ids of other realms pass through. */
function localizeId(value: string, workerId: string): string {
  const prefix = `${workerId}-`;
  if (!value.startsWith(prefix)) return value;
  const local = value.slice(prefix.length);
  const instance = /^(\d+)(:.*)?$/.exec(local);
  if (!instance) return local;
  const [, digits, suffix] = instance as unknown as [string, string, string | undefined];
  return `w${digits}${suffix ?? ''}`;
}

/** `w1` -> `k1-1`, `w1:0x10` -> `k1-1:0x10`, `s1` -> `k1-s1`; anything else is left alone. */
function externalizeId(value: string, workerId: string): string {
  const instance = /^w(\d+)(:.*)?$/.exec(value);
  if (instance) {
    const [, digits, suffix] = instance as unknown as [string, string, string | undefined];
    return `${workerId}-${digits}${suffix ?? ''}`;
  }
  return /^[sfvhp]\d+$/.test(value) ? `${workerId}-${value}` : value;
}

/** `unknown instance "w9"` -> `unknown instance "k1-9"`, so the caller sees the id it sent. */
function externalizeIdsInText(text: string, workerId: string): string {
  return text
    .replace(/\bw(\d+)\b/g, (_match, digits: string) => `${workerId}-${digits}`)
    .replace(/\b([sfvhp])(\d+)\b/g, (_match, prefix: string, digits: string) => `${workerId}-${prefix}${digits}`);
}

function workerScope(): WorkerScope | null {
  if (typeof self === 'undefined') return null;
  const candidate = self as unknown as Partial<WorkerScope>;
  if (typeof candidate.postMessage !== 'function' || typeof candidate.addEventListener !== 'function') return null;
  return candidate as WorkerScope;
}

function main(): void {
  const scope = workerScope();
  if (!scope) return;
  const workerId =
    typeof scope.__wasmcheatWorkerId === 'string' && scope.__wasmcheatWorkerId !== ''
      ? scope.__wasmcheatWorkerId
      : FALLBACK_WORKER_ID;
  const agent = new WorkerAgent({ workerId, post: (message) => scope.postMessage(message) });
  scope.addEventListener('message', (event) => {
    void agent.handleMessage(event.data);
  });
}

main();
