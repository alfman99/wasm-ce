import {
  BridgeError,
  workerIdOf,
  type Address,
  type FreezeEntry,
  type HookEntry,
  type HookSpec,
  type InstanceHost,
  type InstanceInfo,
  type PageDiagnostics,
  type PageAgentInfo,
  type PatchEntry,
  type PatchSpec,
  type PointerPath,
  type PointerResolution,
  type PointerScanOptions,
  type ReadResult,
  type ScanMode,
  type ScanOptions,
  type TextScanOptions,
  type TextScanResult,
  type TraceArmOptions,
  type WatchEntry,
  type WatchEvent,
  type WorkerInfo,
  type WorkerMessage,
  type WorkerType,
  type WriteTraceStatus,
  type ValueType,
  type WriteResult,
  VALUE_TYPE_BYTES,
} from '@wasmcheat/protocol';
import { MemoryAccess } from './memory.js';
import {
  WasmRegistry,
  patchStats,
  type InstrumentedBinary,
  type InstrumentModes,
  type TrackedInstance,
} from './registry.js';
import { ScanStore, scanText } from './scanner.js';
import { HookStore, detectEvalAllowed } from './hooks.js';
import { TraceStore } from './trace.js';
import { PatchStore } from './patch.js';
import { pointerResolve, pointerScan } from './pointer.js';
import { instrumentModule } from '@wasmcheat/wasm-instrument';

const AGENT_VERSION = '0.1.0';
const FREEZE_INTERVAL_MS = 16;
const WATCH_INTERVAL_MS = 50;
const MAX_EVENTS_PER_WATCH = 200;
/** How long a forwarded call waits for a worker's answer before the caller is told it timed out. */
const WORKER_CALL_TIMEOUT_MS = 30_000;
/** Probing a worker (hello, list) must not hang a listing because one worker never started. */
const WORKER_PROBE_TIMEOUT_MS = 2_000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One bootstrapped worker, as the page realm knows it. */
interface WorkerChannel {
  readonly id: string;
  readonly url: string;
  readonly type: WorkerType;
  readonly post: (message: WorkerMessage) => void;
  instances: number;
  /** Set by `removeWorker`; ids keep routing here so callers get a precise error. */
  terminated: boolean;
  readonly pending: Map<string, PendingCall>;
  nextCallId: number;
}

/** What the Worker wrapper in the page realm hands over for each worker it bootstraps. */
export interface WorkerLink {
  readonly id: string;
  readonly url: string;
  readonly type: WorkerType;
  post(message: WorkerMessage): void;
}

export interface PageRuntimeOptions {
  /** Realm this runtime answers for. A worker-scope runtime names everything it mints. */
  realm?: InstanceHost;
  /** Prefix a worker realm must put on its ids, e.g. `k1`. Absent in the page realm. */
  workerId?: string;
}

interface FreezeRecord extends FreezeEntry {
  instanceId: string;
  offset: number;
  lastWritten: number;
}

interface WatchRecord extends WatchEntry {
  offset: number;
  events: WatchEvent[];
}

/** All page-side state and the method table the bridge dispatches into. */
export class PageRuntime {
  readonly registry: WasmRegistry;
  readonly scans = new ScanStore();
  readonly hooks: HookStore;
  readonly trace: TraceStore;
  readonly channelId = randomId();

  private readonly freezes = new Map<string, FreezeRecord>();
  private readonly watches = new Map<string, WatchRecord>();
  private readonly patches: PatchStore;
  private readonly workers = new Map<string, WorkerChannel>();
  private freezeTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private disposed = false;
  private eventListener: ((event: string, data: unknown) => void) | null = null;

  /** Realm this runtime answers for, which is what instance ids get tagged with. */
  readonly realm: InstanceHost;
  /** Prefix this realm puts on the ids it mints; null in the page realm. */
  private readonly workerId: string | null;

  constructor(options: PageRuntimeOptions = {}) {
    this.realm = options.realm ?? 'page';
    this.workerId = options.workerId ?? null;
    this.registry = new WasmRegistry({
      onInstrumented: (tracked) => this.trace.onInstrumented(tracked),
    });
    this.hooks = new HookStore(this.registry, detectEvalAllowed());
    this.trace = new TraceStore(
      this.registry,
      (bytes, modes) => this.rewriteBinary(bytes, modes),
      () => this.refreshInstrumenter(),
    );
    this.trace.onHit((hit) => this.emitEvent('trace.hit', hit));
    this.patches = new PatchStore(() => this.refreshInstrumenter());
  }

  /**
   * Occurrences worth pushing rather than asking about, currently a watchpoint hit. The page agent
   * forwards them to the bridge so an MCP caller can wait for the event itself; a caller that
   * never subscribes simply loses nothing (the same hit is still in `trace.status()`).
   */
  onEvent(listener: (event: string, data: unknown) => void): void {
    this.eventListener = listener;
  }

  private emitEvent(event: string, data: unknown): void {
    try {
      this.eventListener?.(event, data);
    } catch {
      // Emitting happens inside the instrumented wasm's own store path: a broken listener must
      // not turn a traced write into a trap.
    }
  }

  /**
   * One rewrite pass serves watchpoints and function patches, because a second pass would shift
   * function indices a second time and add a duplicate `__wc_arm` export. Whoever changes the plan
   * (arming, stopping, adding a patch) rebuilds the instrumenter from both stores.
   */
  private refreshInstrumenter(): void {
    const modes = this.trace.modes();
    if (!modes && !this.patches.active) {
      this.registry.setInstrumenter(null);
      return;
    }
    this.registry.setInstrumenter({
      modes: modes ?? { reads: false, writes: false },
      rewrite: (bytes, requested) => this.rewriteBinary(bytes, requested),
      onStore: (funcIndex) => this.trace.handleStore(funcIndex),
      onRead: (address, funcIndex) => this.trace.handleRead(address, funcIndex),
    });
  }

  private pointerScan(options: PointerScanOptions): PointerPath[] {
    const { access } = this.access(options.instanceId);
    return pointerScan(access, options);
  }

  private pointerResolve(params: { base: number; offsets: number[]; instanceId: string }): PointerResolution {
    const { access } = this.access(params.instanceId);
    return pointerResolve(access, params.instanceId, params.base, params.offsets);
  }

  private rewriteBinary(bytes: Uint8Array, modes: InstrumentModes): InstrumentedBinary {
    const instrumented = instrumentModule(bytes, { ...modes, patches: this.patches.activePatches() });
    if (instrumented.patchedFunctions) this.patches.markApplied(instrumented.patchedFunctions);
    return {
      bytes: instrumented.bytes,
      importModule: instrumented.importModule,
      importField: instrumented.importField,
      readField: 'on_read',
      armExport: instrumented.armExport,
    };
  }

  install(): void {
    this.registry.install();
  }

  dispose(): void {
    this.disposed = true;
    if (this.freezeTimer) clearInterval(this.freezeTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.freezeTimer = null;
    this.watchTimer = null;
    this.freezes.clear();
    this.watches.clear();
    for (const hook of this.hooks.list()) this.hooks.remove(hook.id);
  }

  info(): PageAgentInfo {
    return { version: AGENT_VERSION, url: pageUrl(), evalAllowed: this.hooks.evalAllowed };
  }

  /**
   * "Why does this tab show no instances?" — every real cause is observable from here:
   * the app never called a patched entry point, it lives in a frame we are not in, or it
   * simply is not a wasm app (JS/canvas).
   */
  diagnose(): PageDiagnostics {
    const hasDocument = typeof document !== 'undefined';
    const stats = patchStats();
    const calls = stats.calls;
    const instances = this.registry.list().length;
    const iframes = readIframes();
    const canvases = hasDocument ? document.querySelectorAll('canvas').length : 0;
    const attempts = calls.instantiate + calls.instantiateStreaming + calls.newInstance;
    const crossOrigin = iframes.find((frame) => frame.crossOrigin);

    let hint: string;
    if (instances > 0) {
      hint = `${instances} instance(s) captured; use wasmcheat_list_instances, then scan.`;
    } else if (crossOrigin) {
      hint =
        `This document has a cross-origin frame (${crossOrigin.src}) and no wasm of its own. ` +
        'The game is probably inside that frame; subframe injection is not enabled in this build.';
    } else if (attempts === 0) {
      hint =
        'The agent is installed but the page never called WebAssembly.instantiate. Either the app is ' +
        'not a wasm app, or it instantiates inside a worker/iframe, or it loaded before the agent and ' +
        'needs a reload (attach with reload=true).';
    } else {
      hint = `${attempts} instantiation(s) observed but none captured; the app may use WebAssembly in a way this build does not track.`;
    }

    return {
      ...this.info(),
      title: hasDocument ? document.title : '',
      readyState: hasDocument ? document.readyState : 'worker',
      calls,
      agentAgeMs: Date.now() - stats.installedAt,
      instances,
      iframes,
      canvases,
      wasmReferences: wasmReferences(),
      hint,
    };
  }

  /**
   * Every instance this agent can see, this realm's and its workers' merged. Worker instances keep
   * the ids the worker minted (`k1-1`), so a later call routes back on the id alone.
   */
  async listInstances(): Promise<InstanceInfo[]> {
    const merged = this.localInstances();
    for (const channel of this.workers.values()) {
      if (channel.terminated) continue;
      try {
        const instances = (await this.workerCall(
          channel.id,
          'page.listInstances',
          {},
          WORKER_PROBE_TIMEOUT_MS,
        )) as InstanceInfo[];
        channel.instances = instances.length;
        merged.push(...instances);
      } catch {
        // One unreachable worker must not blank the listing for the realm that does answer.
      }
    }
    // `latest` means newest by creation time, and workers are visited after the page realm.
    return merged.sort((a, b) => a.createdAt - b.createdAt);
  }

  private localInstances(): InstanceInfo[] {
    return this.registry.list().map((tracked) => {
      const info = this.registry.describe(tracked);
      return this.workerId === null
        ? { ...info, host: this.realm }
        : { ...info, host: this.realm, workerId: this.workerId };
    });
  }

  // ---------------------------------------------------------------- workers

  /** Workers this agent bootstrapped, with a freshly probed instance count. */
  async listWorkers(): Promise<WorkerInfo[]> {
    const infos: WorkerInfo[] = [];
    for (const channel of this.workers.values()) {
      if (channel.terminated) continue;
      try {
        const instances = await this.workerCall(
          channel.id,
          'page.listInstances',
          {},
          WORKER_PROBE_TIMEOUT_MS,
        );
        if (Array.isArray(instances)) channel.instances = instances.length;
      } catch {
        // A worker that never ran the agent keeps its last known count and stays listed.
      }
      infos.push({ id: channel.id, url: channel.url, type: channel.type, instances: channel.instances });
    }
    return infos;
  }

  /** Called by the Worker wrapper for every worker whose bootstrap it installed. */
  addWorker(link: WorkerLink): void {
    this.workers.set(link.id, {
      id: link.id,
      url: link.url,
      type: link.type,
      post: link.post,
      instances: 0,
      terminated: false,
      pending: new Map(),
      nextCallId: 1,
    });
    // The worker answers the handshake before it holds any instance, so a game that has not
    // compiled its module yet still shows up in list_workers.
    try {
      link.post({ __wasmcheat: 'hello' });
    } catch {
      // A worker that died during startup simply never answers; the probe times out.
    }
  }

  /** `terminate()` landed: ids keep routing here so a caller learns why instead of hanging. */
  removeWorker(workerId: string): void {
    const channel = this.workers.get(workerId);
    if (!channel || channel.terminated) return;
    channel.terminated = true;
    for (const entry of channel.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.deadWorker(workerId, channel));
    }
    channel.pending.clear();
  }

  /** Answers arriving from a worker: the hello probe and the replies to forwarded calls. */
  handleWorkerMessage(workerId: string, message: WorkerMessage): void {
    const channel = this.workers.get(workerId);
    if (!channel) return;
    if (message.__wasmcheat === 'hello') {
      if ('info' in message) channel.instances = message.info.instances;
      return;
    }
    if (message.__wasmcheat !== 'result') return;
    const entry = channel.pending.get(message.id);
    if (!entry) return;
    channel.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      // PostMessage flattens the error to its shape; rebuild it so callers keep seeing BridgeError.
      const shape = message.error;
      entry.reject(new BridgeError(shape.code, shape.message, shape.detail));
      return;
    }
    entry.resolve(message.result);
  }

  /** Forward one page method into a worker realm and wait for its answer. */
  async workerCall(
    workerId: string,
    method: string,
    params: unknown = {},
    timeoutMs = WORKER_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const channel = this.workers.get(workerId);
    if (!channel) {
      throw new BridgeError('NO_INSTANCE', `no worker "${workerId}" is instrumented in this page`, {
        workers: [...this.workers.keys()],
      });
    }
    if (channel.terminated) throw this.deadWorker(workerId, channel);

    const id = String(channel.nextCallId++);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.pending.delete(id);
        reject(
          new BridgeError(
            'TIMEOUT',
            `worker ${workerId} did not answer ${method} within ${timeoutMs}ms: it may be busy, blocked, or never ran the agent`,
            { workerId },
          ),
        );
      }, timeoutMs);
      channel.pending.set(id, { resolve, reject, timer });
      try {
        channel.post({ __wasmcheat: 'call', id, method, params });
      } catch (error) {
        channel.pending.delete(id);
        clearTimeout(timer);
        reject(this.deadWorker(workerId, channel, error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private deadWorker(workerId: string, channel: WorkerChannel, reason?: string): BridgeError {
    const why = reason ? `cannot reach it: ${reason}` : '';
    return new BridgeError(
      'NO_INSTANCE',
      `worker ${workerId} (${channel.url}) is gone${why ? ` (${why})` : ''}; its instances no longer exist — reload the tab`,
      { workerId, url: channel.url },
    );
  }

  // ---------------------------------------------------------------- memory

  private access(instanceId: string): { tracked: TrackedInstance; access: MemoryAccess } {
    // "latest" is how an address stays valid across the reloads real apps do: the id is resolved
    // at call time instead of being baked into a string the agent remembered.
    const resolved = instanceId === 'latest' ? this.registry.list().at(-1)?.id ?? instanceId : instanceId;
    const tracked = this.registry.get(resolved);
    const instanceId2 = resolved;
    if (!tracked) {
      throw new BridgeError('NO_INSTANCE', `unknown instance "${instanceId}"`, {
        known: this.registry.list().map((entry) => entry.id),
      });
    }
    if (!tracked.memory) {
      throw new BridgeError(
        'NO_MEMORY',
        `instance ${instanceId2} exposes no WebAssembly.Memory (checked exports and imports)`,
      );
    }
    return { tracked, access: new MemoryAccess(tracked.memory) };
  }

  read(params: { address: Address; type: ValueType; count?: number; length?: number; encoding?: 'hex' | 'base64' }): ReadResult {
    const { access } = this.access(params.address.instanceId);
    if (params.length !== undefined) {
      const bytes = access.readBytes(params.address.offset, params.length);
      const hex = toHex(bytes);
      return {
        address: params.address,
        type: params.type,
        values: Array.from(bytes),
        hex: params.encoding === 'base64' ? toBase64(bytes) : hex,
      };
    }
    if (!(params.type in VALUE_TYPE_BYTES)) {
      throw new BridgeError('BAD_PARAMS', `unknown value type "${String(params.type)}"`);
    }
    const width = VALUE_TYPE_BYTES[params.type];
    const count = Math.max(1, Math.min(params.count ?? 1, 4096));
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      values.push(access.read(params.address.offset + i * width, params.type));
    }
    return { address: params.address, type: params.type, values };
  }

  write(params: { address: Address; type: ValueType; value: number }): WriteResult {
    const { access } = this.access(params.address.instanceId);
    if (!(params.type in VALUE_TYPE_BYTES)) {
      throw new BridgeError('BAD_PARAMS', `unknown value type "${String(params.type)}"`);
    }
    const before = access.read(params.address.offset, params.type);
    access.write(params.address.offset, params.type, params.value);
    const after = access.read(params.address.offset, params.type);
    return { address: params.address, type: params.type, before, after };
  }

  // ---------------------------------------------------------------- scanning

  scanBegin(options: ScanOptions): ReturnType<ScanStore['pass']> {
    const { access } = this.access(options.instanceId);
    return this.scans.pass(access, options);
  }

  scanText(params: TextScanOptions): TextScanResult {
    const { access } = this.access(params.instanceId);
    return scanText(access, params);
  }

  scanNext(params: {
    scanId: string;
    mode: ScanMode;
    value?: number;
    value2?: number;
    tolerance?: number;
  }): ReturnType<ScanStore['narrow']> {
    const session = this.scans.get(params.scanId);
    const { access } = this.access(session.instanceId);
    return this.scans.narrow(access, params.scanId, params.mode, {
      value2: params.value2,
      value: params.value,
      tolerance: params.tolerance,
    });
  }

  scanResults(params: { scanId: string; offset?: number; limit?: number }): { hits: { address: Address; value: number }[]; total: number } {
    const session = this.scans.get(params.scanId);
    const { access } = this.access(session.instanceId);
    return this.scans.results(params.scanId, access, params.offset ?? 0, params.limit ?? 50);
  }

  scanDrop(params: { scanId: string }): boolean {
    return this.scans.drop(params.scanId);
  }

  // ---------------------------------------------------------------- freezes

  freezeSet(params: { address: Address; type: ValueType; value: number }): FreezeEntry {
    const { access } = this.access(params.address.instanceId);
    access.read(params.address.offset, params.type); // validates range up front
    const id = `f${this.nextId++}`;
    const record: FreezeRecord = {
      id,
      address: params.address,
      instanceId: params.address.instanceId,
      offset: params.address.offset,
      type: params.type,
      value: params.value,
      createdAt: Date.now(),
      lastWritten: Number.NaN,
    };
    this.freezes.set(id, record);
    this.ensureFreezeTimer();
    return stripFreeze(record);
  }

  freezeClear(params: { freezeId: string }): boolean {
    const removed = this.freezes.delete(params.freezeId);
    if (this.freezes.size === 0 && this.freezeTimer) {
      clearInterval(this.freezeTimer);
      this.freezeTimer = null;
    }
    return removed;
  }

  freezeList(): FreezeEntry[] {
    return [...this.freezes.values()].map(stripFreeze);
  }

  private ensureFreezeTimer(): void {
    if (this.freezeTimer || this.disposed) return;
    this.freezeTimer = setInterval(() => {
      for (const record of this.freezes.values()) {
        try {
          const { access } = this.access(record.instanceId);
          const current = access.read(record.offset, record.type);
          if (current !== record.value) {
            access.write(record.offset, record.type, record.value);
            record.lastWritten = Date.now();
          }
        } catch {
          // A detached buffer mid-grow resolves on the next tick; a removed instance drops out.
          if (!this.registry.get(record.instanceId)) this.freezes.delete(record.id);
        }
      }
    }, FREEZE_INTERVAL_MS);
  }

  // ---------------------------------------------------------------- watches

  watchAdd(params: { address: Address; type: ValueType }): WatchEntry {
    const { access } = this.access(params.address.instanceId);
    const current = access.read(params.address.offset, params.type);
    const id = `v${this.nextId++}`;
    const record: WatchRecord = {
      id,
      address: params.address,
      offset: params.address.offset,
      type: params.type,
      lastValue: current,
      createdAt: Date.now(),
      events: [],
    };
    this.watches.set(id, record);
    this.ensureWatchTimer();
    return stripWatch(record);
  }

  watchRemove(params: { watchId: string }): boolean {
    const removed = this.watches.delete(params.watchId);
    if (this.watches.size === 0 && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    return removed;
  }

  watchList(): WatchEntry[] {
    return [...this.watches.values()].map(stripWatch);
  }

  watchPoll(params: { limit?: number }): WatchEvent[] {
    const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
    const events: WatchEvent[] = [];
    for (const watch of this.watches.values()) {
      while (watch.events.length > 0 && events.length < limit) {
        events.push(watch.events.shift()!);
      }
      if (events.length >= limit) break;
    }
    return events;
  }

  private ensureWatchTimer(): void {
    if (this.watchTimer || this.disposed) return;
    this.watchTimer = setInterval(() => {
      for (const watch of this.watches.values()) {
        try {
          const { access } = this.access(watch.address.instanceId);
          const current = access.read(watch.offset, watch.type);
          if (current !== watch.lastValue) {
            const event: WatchEvent = {
              watchId: watch.id,
              address: watch.address,
              type: watch.type,
              before: watch.lastValue,
              after: current,
              at: Date.now(),
            };
            watch.lastValue = current;
            watch.events.push(event);
            if (watch.events.length > MAX_EVENTS_PER_WATCH) watch.events.shift();
          }
        } catch {
          if (!this.registry.get(watch.address.instanceId)) this.watches.delete(watch.id);
        }
      }
    }, WATCH_INTERVAL_MS);
  }

  // ---------------------------------------------------------------- hooks

  hookAdd(spec: HookSpec): HookEntry {
    return this.hooks.add(spec);
  }

  hookList(): HookEntry[] {
    return this.hooks.list();
  }

  hookSetEnabled(params: { hookId: string; enabled: boolean }): HookEntry {
    return this.hooks.setEnabled(params.hookId, params.enabled);
  }

  hookRemove(params: { hookId: string }): boolean {
    return this.hooks.remove(params.hookId);
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * A call whose id belongs to a worker goes there; everything else runs here. Ids carry their
   * owner (`k1-1`, `k1-s1`), so routing is a decode rather than a table that could go stale.
   */
  private routeOwner(params: unknown): string | null {
    if (!params || typeof params !== 'object') return null;
    const record = params as Record<string, unknown>;
    const candidates: unknown[] = [
      record.instanceId,
      record.scanId,
      record.freezeId,
      record.watchId,
      record.hookId,
      record.patchId,
    ];
    const address = record.address;
    if (typeof address === 'string') candidates.push(address);
    else if (address && typeof address === 'object') candidates.push((address as Address).instanceId);
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const owner = workerIdOf(candidate);
      if (owner && this.workers.has(owner)) return owner;
    }
    return null;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    const owner = this.routeOwner(params);
    if (owner) return this.workerCall(owner, method, params);
    switch (method) {
      case 'page.listInstances':
        return this.listInstances();
      case 'page.listWorkers':
        return this.listWorkers();
      case 'page.freeze.list':
        return this.mergeWorkers('page.freeze.list', params);
      case 'page.watch.list':
        return this.mergeWorkers('page.watch.list', params);
      case 'page.watch.poll':
        return this.mergeWorkers('page.watch.poll', params);
      case 'page.hook.list':
        return this.mergeWorkers('page.hook.list', params);
      case 'page.patch.list':
        return this.mergeWorkers('page.patch.list', params);
      default:
        return this.local(method, params);
    }
  }

  /** Session objects live in the realm that minted them; the list output is the merged view. */
  private async mergeWorkers(method: string, params: unknown): Promise<unknown[]> {
    const merged = this.local(method, params) as unknown[];
    for (const channel of this.workers.values()) {
      if (channel.terminated) continue;
      try {
        const fromWorker = await this.workerCall(channel.id, method, params, WORKER_PROBE_TIMEOUT_MS);
        if (Array.isArray(fromWorker)) merged.push(...fromWorker);
      } catch {
        // One unreachable worker must not hide the entries this realm owns.
      }
    }
    return merged;
  }

  /** Methods answered by this realm alone. */
  private local(method: string, params: unknown): unknown {
    const p = (params ?? {}) as never;
    switch (method) {
      case 'page.hello':
        return this.info();
      case 'page.listInstances':
        return this.localInstances();
      case 'page.diagnose':
        return this.diagnose();
      case 'page.read':
        return this.read(p);
      case 'page.write':
        return this.write(p);
      case 'page.scan.begin':
        return this.scanBegin(p);
      case 'page.scan.next':
        return this.scanNext(p);
      case 'page.scan.text':
        return this.scanText(p as unknown as TextScanOptions);
      case 'page.scan.results':
        return this.scanResults(p);
      case 'page.scan.drop':
        return this.scanDrop(p);
      case 'page.freeze.set':
        return this.freezeSet(p);
      case 'page.freeze.clear':
        return this.freezeClear(p);
      case 'page.freeze.list':
        return this.freezeList();
      case 'page.watch.add':
        return this.watchAdd(p);
      case 'page.watch.remove':
        return this.watchRemove(p);
      case 'page.watch.list':
        return this.watchList();
      case 'page.watch.poll':
        return this.watchPoll(p);
      case 'page.hook.add':
        return this.hookAdd(p);
      case 'page.hook.list':
        return this.hookList();
      case 'page.hook.setEnabled':
        return this.hookSetEnabled(p);
      case 'page.hook.remove':
        return this.hookRemove(p);
      case 'page.trace.arm':
        return this.trace.arm(p as unknown as TraceArmOptions);
      case 'page.trace.stop':
        return this.trace.stop();
      case 'page.trace.status':
        return this.trace.status();
      case 'page.trace.clear':
        return this.trace.clear();
      case 'page.trace.hits':
        return this.trace.hits((p as { limit?: number }).limit);
      case 'page.pointer.scan':
        return this.pointerScan(p as unknown as PointerScanOptions);
      case 'page.pointer.resolve':
        return this.pointerResolve(p as unknown as { base: number; offsets: number[]; instanceId: string });
      case 'page.patch.add':
        return this.patches.add(p as unknown as PatchSpec);
      case 'page.patch.list':
        return this.patches.list();
      case 'page.patch.remove':
        return this.patches.remove((p as { patchId: string }).patchId);
      case 'page.patch.clear':
        return this.patches.clear();
      default:
        throw new BridgeError('BAD_PARAMS', `unknown page method "${method}"`);
    }
  }
}

function stripFreeze(record: FreezeRecord): FreezeEntry {
  return {
    id: record.id,
    address: record.address,
    type: record.type,
    value: record.value,
    createdAt: record.createdAt,
  };
}

function stripWatch(record: WatchRecord): WatchEntry {
  return {
    id: record.id,
    address: record.address,
    type: record.type,
    lastValue: record.lastValue,
    createdAt: record.createdAt,
  };
}

/** `location` exists in a worker too, but not in the realm the unit tests run in. */
function pageUrl(): string {
  return typeof location === 'undefined' ? '' : location.href;
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ch_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A cross-origin iframe is the usual reason a tab "has no wasm": the game runs in its own
 * document, which this agent (top frame only) is not inside. `src` is readable even when the
 * frame's contents are not.
 */
function readIframes(): { src: string; crossOrigin: boolean; width: number; height: number }[] {
  if (typeof document === 'undefined') return [];
  const frames: { src: string; crossOrigin: boolean; width: number; height: number }[] = [];
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    const src = frame.getAttribute('src') ?? '';
    let crossOrigin = false;
    try {
      crossOrigin = src !== '' && new URL(src, location.href).origin !== location.origin;
    } catch {
      crossOrigin = src !== '';
    }
    const rect = frame.getBoundingClientRect();
    frames.push({ src, crossOrigin, width: Math.round(rect.width), height: Math.round(rect.height) });
  }
  return frames.slice(0, 10);
}

/** `.wasm` URLs that appear in the markup — a cheap way to see whether wasm lives here at all. */
function wasmReferences(): string[] {
  if (typeof document === 'undefined') return [];
  const html = document.documentElement?.outerHTML ?? '';
  const found = html.match(/[^"'\s>]*\.wasm(?:\?[^"'\s>]*)?/g) ?? [];
  return Array.from(new Set(found)).slice(0, 5);
}
