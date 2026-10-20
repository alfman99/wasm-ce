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
  type ScanHit,
  type ScanMode,
  type ScanOptions,
  type ScanSummary,
  type SavedScanSummary,
  type TextScanOptions,
  type TextScanResult,
  type SpeedStatus,
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
import { TimeMachine } from './speed.js';
import { deleteSaved, listSaved, loadSaved, saveScan } from './saved-scans.js';
import { addBookmark, clearBookmarks, listBookmarks, removeBookmark } from './bookmarks.js';
import { HookStore } from './hooks.js';
import { runScript } from './script.js';
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
  /** Page clock scaling; inert until `install()` runs in a document realm. */
  readonly speed = new TimeMachine();
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
      onMissedInstrumentation: (tracked) => this.trace.onMissedInstrumentation(tracked),
    });
    this.hooks = new HookStore(this.registry);
    this.trace = new TraceStore(
      this.registry,
      (bytes, modes) => this.rewriteBinary(bytes, modes),
      () => this.refreshInstrumenter(),
    );
    this.trace.onHit((hit) => this.emitEvent('trace.hit', hit));
    this.patches = new PatchStore(() => this.refreshInstrumenter());
    // Patches restored from a previous document never fired `onWiringChange`, so wire them now.
    this.refreshInstrumenter();
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
      onStore: (funcIndex, instance) => this.trace.handleStore(funcIndex, instance),
      onRead: (address, funcIndex, instance) => this.trace.handleRead(address, funcIndex, instance),
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
    const references = wasmReferences();
    const engine = physicsEngine(references);

    let hint: string;
    if (instances > 0 && engine) {
      hint =
        `${instances} instance(s) captured, all from ${engine}, a physics engine: its memory holds bodies, forces ` +
        'and collisions. The score, coins and rules of this game live in JavaScript, which a wasm scan cannot reach.';
    } else if (instances > 0) {
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
      wasmReferences: references,
      ...(engine ? { physicsEngine: engine } : {}),
      hint,
    };
  }

  /**
   * Every instance this agent can see, this realm's and its workers' merged. Worker instances keep
   * the ids the worker minted (`k1-1`), so a later call routes back on the id alone.
   */
  async listInstances(): Promise<InstanceInfo[]> {
    const merged = this.localInstances();
    const channels = this.liveWorkers();
    const answers = await Promise.allSettled(
      channels.map((channel) => this.workerCall(channel.id, 'page.listInstances', {}, WORKER_PROBE_TIMEOUT_MS)),
    );
    // One unreachable worker must not blank the listing for the realm that does answer.
    answers.forEach((answer, i) => {
      if (answer.status !== 'fulfilled' || !Array.isArray(answer.value)) return;
      channels[i]!.instances = answer.value.length;
      merged.push(...(answer.value as InstanceInfo[]));
    });
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
    // Probed in parallel: a pthread-pool worker parked in `Atomics.wait` never answers, and one
    // timeout per worker in sequence would outlast the bridge's own deadline.
    const listed = await Promise.all(
      this.liveWorkers().map(async (channel) => {
        const [instances, nested] = await Promise.allSettled([
          this.workerCall(channel.id, 'page.listInstances', {}, WORKER_PROBE_TIMEOUT_MS),
          this.workerCall(channel.id, 'page.listWorkers', {}, WORKER_PROBE_TIMEOUT_MS),
        ]);
        // A worker that never ran the agent keeps its last known count and stays listed.
        if (instances.status === 'fulfilled' && Array.isArray(instances.value)) channel.instances = instances.value.length;
        const info: WorkerInfo = { id: channel.id, url: channel.url, type: channel.type, instances: channel.instances };
        // A worker's own workers: their ids already carry the chain (`k1n1`), so they need no prefixing.
        // An unreachable child leaves the parent listed, which is enough to explain the gap.
        return nested.status === 'fulfilled' && Array.isArray(nested.value)
          ? [info, ...(nested.value as WorkerInfo[])]
          : [info];
      }),
    );
    return listed.flat();
  }

  private liveWorkers(): WorkerChannel[] {
    return [...this.workers.values()].filter((channel) => !channel.terminated);
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
    // A worker started after a speed change would otherwise run its clock at 1x. The message waits in
    // the worker's queue until its agent boots, so a timeout here does not mean it was lost.
    if (this.speed.scale !== 1) {
      this.workerCall(link.id, 'page.speed.set', { scale: this.speed.scale }, WORKER_PROBE_TIMEOUT_MS).catch(() => undefined);
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

  /** Applies a speed scale here and in every worker realm this page owns. */
  private async setSpeedEverywhere(scale: number): Promise<SpeedStatus> {
    const status = this.speed.set(scale);
    await Promise.all(
      [...this.workers.keys()].map(async (id) => {
        try {
          await this.workerCall(id, 'page.speed.set', { scale }, WORKER_PROBE_TIMEOUT_MS);
        } catch {
          // A worker that is gone or blocked must not fail the page's own speed change.
        }
      }),
    );
    return status;
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
      `worker ${workerId} (${channel.url}) is gone${why ? ` (${why})` : ''}; its instances no longer exist. Reload the tab`,
      { workerId, url: channel.url },
    );
  }

  // ---------------------------------------------------------------- memory

  /**
   * "latest" is how an address stays valid across the reloads real apps do: the id is resolved
   * at call time instead of being baked into a string the agent remembered.
   */
  private resolveInstanceId(instanceId: string): string {
    return instanceId === 'latest' ? this.registry.list().at(-1)?.id ?? instanceId : instanceId;
  }

  private access(instanceId: string): { tracked: TrackedInstance; access: MemoryAccess } {
    const resolved = this.resolveInstanceId(instanceId);
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

  /** Freezes a narrowed session under a name so a reload does not cost the user the work. */
  savedSave(params: { name?: unknown; scanId?: string }): SavedScanSummary {
    const scanId = params?.scanId;
    if (typeof scanId !== 'string') throw new BridgeError('BAD_PARAMS', 'scanId is required');
    return saveScan(params?.name, this.scans.serialize(scanId));
  }

  /** Rebuilds a saved session; the returned scanId narrows exactly like a fresh one. */
  savedOpen(params: { name?: unknown; instanceId?: string }): { scanId: string; instanceId: string; summary: ScanSummary } {
    const data = loadSaved(params?.name);
    // A reload creates a new instance object, which the registry numbers from w1 again, so the
    // saved id is usually still right; a caller that knows better can override it.
    const instanceId = params?.instanceId ?? data.instanceId;
    const { access } = this.access(instanceId);
    return { ...this.scans.adopt(access, { ...data, instanceId }), instanceId };
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

  scanResults(params: { scanId: string; offset?: number; limit?: number }): { hits: ScanHit[]; total: number } {
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
    // Pinned once: a timer that re-resolved "latest" every tick would silently move to a new instance.
    const address = { ...params.address, instanceId: this.resolveInstanceId(params.address.instanceId) };
    const id = `f${this.nextId++}`;
    const record: FreezeRecord = {
      id,
      address,
      instanceId: address.instanceId,
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
    // Pinned once, like a freeze: "latest" must not retarget the watch when a new instance appears.
    const address = { ...params.address, instanceId: this.resolveInstanceId(params.address.instanceId) };
    const id = `v${this.nextId++}`;
    const record: WatchRecord = {
      id,
      address,
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
          // Object.is: a NaN that stays NaN is not a change, and NaN !== NaN would log one every tick.
          if (!Object.is(current, watch.lastValue)) {
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
      // A nested realm's id (`k1n1-1`) names a channel this realm does not own, but a channel it does
      // own (`k1`) is a prefix of it. Hand the call down and let that realm route the rest; each level
      // only ever strips its own prefix, so the id survives unchanged until it reaches its owner.
      for (const id of this.workers.keys()) {
        if (this.workers.get(id)?.terminated) continue;
        // A nested realm's id continues with `n<number>` (`k1n1-1` under channel `k1`), while this
        // realm's own ids continue with `-`. Requiring that shape keeps `k1` from swallowing `k12`.
        if (candidate.startsWith(id) && /^n\d/.test(candidate.slice(id.length))) return id;
      }
    }
    return null;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    const owner = this.routeOwner(params);
    if (owner) return this.workerCall(owner, method, params);
    switch (method) {
      case 'page.listInstances':
        // Nested realms contribute here too, so `list_instances` shows a worker's worker's wasm.
        return this.mergeWorkers('page.listInstances', params);
      case 'page.listWorkers':
        return this.listWorkers();
      case 'page.speed.set':
        // A game that reads the clock inside a worker keeps real time unless the workers are told too.
        // The broadcast recurses down the chain: each realm applies the scale and forwards it.
        return this.setSpeedEverywhere(Number((params as { scale?: unknown } | null)?.scale));
      case 'page.speed.status':
        return this.speed.status();
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
    const answers = await Promise.allSettled(
      this.liveWorkers().map((channel) => this.workerCall(channel.id, method, params, WORKER_PROBE_TIMEOUT_MS)),
    );
    // One unreachable worker must not hide the entries this realm owns; order stays the workers' order.
    for (const answer of answers) {
      if (answer.status === 'fulfilled' && Array.isArray(answer.value)) merged.push(...answer.value);
    }
    return merged;
  }

  /**
   * Features that keep state in Web Storage, which a worker global does not have. Saying so beats the
   * confusing storage error (or, for a watchpoint, the silent loss at reload) the call would produce.
   */
  private refuseInWorker(feature: string, reason: string): void {
    if (this.workerId === null) return;
    throw new BridgeError('UNSUPPORTED', `${feature} is not available for worker instances yet: ${reason}`);
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
      case 'page.saved.list':
        return listSaved();
      case 'page.saved.save':
        this.refuseInWorker('saving a scan', 'a worker has no sessionStorage to keep it in');
        return this.savedSave(p);
      case 'page.saved.open':
        this.refuseInWorker('opening a saved scan', 'a worker has no sessionStorage to keep it in');
        return this.savedOpen(p);
      case 'page.saved.delete':
        return deleteSaved((p as unknown as { name?: unknown })?.name);
      case 'page.bookmark.list':
        return listBookmarks();
      case 'page.bookmark.add':
        this.refuseInWorker('bookmarking an address', 'a worker has no localStorage to keep the address list in');
        return addBookmark(p as { label: unknown; address: unknown; type?: unknown; note?: unknown });
      case 'page.bookmark.remove':
        return removeBookmark((p as unknown as { id?: unknown })?.id);
      case 'page.bookmark.clear':
        return { removed: clearBookmarks() };
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
        this.refuseInWorker(
          'a watchpoint (find_writes/find_reads)',
          'a worker has no sessionStorage, so the watchpoint cannot survive the reload that installs it',
        );
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
      case 'page.script.run':
        return runScript((p as { code?: unknown }).code);
      case 'page.patch.restore':
        return this.patches.adopt((p as { patches?: unknown }).patches);
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

/** Inline script text read per call. YouTube's own inline data alone runs to megabytes. */
const INLINE_SCRIPT_BUDGET = 512 * 1024;
/** Longest URL worth reporting; also bounds the walk back from each `.wasm`. */
const MAX_URL = 400;
const URL_STOP = new Set(['"', "'", '`', '>', '<', '(', ')', ' ', '\n', '\r', '\t']);

/**
 * Every `.wasm` URL in `text`, found by searching for `.wasm` and walking back to the delimiter.
 * Linear on purpose: the obvious regex, `[^"'\s>]*\.wasm`, retries from every character of a run
 * with no delimiter in it, which minified code and inlined base64 are made of. 40 KB of that took
 * 1.4 s, and a game's inline script is often far longer.
 */
export function wasmUrlsIn(text: string, found: Set<string>): void {
  let at = text.indexOf('.wasm');
  while (at !== -1) {
    let start = at;
    while (start > 0 && at - start < MAX_URL && !URL_STOP.has(text[start - 1] ?? ' ')) start--;
    let end = at + 5;
    if (text[end] === '?') while (end < text.length && end - at < MAX_URL && !URL_STOP.has(text[end] ?? ' ')) end++;
    if (start < at) found.add(text.slice(start, end));
    at = text.indexOf('.wasm', end);
  }
}

/**
 * `.wasm` URLs this document fetched or names, a cheap way to see whether wasm lives here at all.
 * Cheap matters: the extension asks every frame of a tab this on each frame pick, and serialising
 * the whole DOM (`outerHTML`) took 2.5 s in a PlayCanvas game and longer on YouTube itself.
 */
function wasmReferences(): string[] {
  if (typeof document === 'undefined') return [];
  const found = new Set<string>();
  const take = (text: string | null | undefined): void => {
    if (text) wasmUrlsIn(text, found);
  };
  for (const entry of performance.getEntriesByType('resource')) {
    if (/\.wasm(?:\?|$)/i.test(entry.name)) found.add(entry.name);
  }
  for (const element of Array.from(document.querySelectorAll('[src], [href]'))) {
    take(element.getAttribute('src') ?? element.getAttribute('href'));
  }
  let budget = INLINE_SCRIPT_BUDGET;
  for (const script of Array.from(document.querySelectorAll('script:not([src])'))) {
    if (budget <= 0) break;
    const text = script.textContent?.slice(0, budget) ?? '';
    budget -= text.length;
    take(text);
  }
  return Array.from(found).slice(0, 5);
}

/** Physics engines that ship as their own .wasm next to a game written in JavaScript. */
const PHYSICS_ENGINES: [RegExp, string][] = [
  [/ammo[\w.-]*\.wasm/i, 'Ammo.js (Bullet)'],
  [/box2d[\w.-]*\.wasm/i, 'Box2D'],
  [/liquidfun[\w.-]*\.wasm/i, 'LiquidFun'],
  [/rapier[\w.-]*\.wasm/i, 'Rapier'],
  [/havok[\w.-]*\.wasm/i, 'Havok'],
  [/jolt[\w.-]*\.wasm/i, 'Jolt Physics'],
  [/physx[\w.-]*\.wasm/i, 'PhysX'],
];

/** The engine's name when every .wasm this page references is a physics engine, else undefined. */
export function physicsEngine(references: string[]): string | undefined {
  const engines = references.map((ref) => PHYSICS_ENGINES.find(([pattern]) => pattern.test(ref))?.[1]);
  return engines.length > 0 && engines.every(Boolean) ? engines[0] : undefined;
}
