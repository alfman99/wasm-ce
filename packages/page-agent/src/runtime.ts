import {
  BridgeError,
  type Address,
  type FreezeEntry,
  type HookEntry,
  type HookSpec,
  type InstanceInfo,
  type PageDiagnostics,
  type PageAgentInfo,
  type ReadResult,
  type ScanMode,
  type ScanOptions,
  type TextScanOptions,
  type TextScanResult,
  type TraceArmOptions,
  type WriteTraceStatus,
  type ValueType,
  type WatchEntry,
  type WatchEvent,
  type WriteResult,
  VALUE_TYPE_BYTES,
} from '@wasmcheat/protocol';
import { MemoryAccess } from './memory.js';
import { WasmRegistry, patchStats, type TrackedInstance } from './registry.js';
import { ScanStore, scanText } from './scanner.js';
import { HookStore, detectEvalAllowed } from './hooks.js';
import { TraceStore } from './trace.js';
import { instrumentModule } from '@wasmcheat/wasm-instrument';

const AGENT_VERSION = '0.1.0';
const FREEZE_INTERVAL_MS = 16;
const WATCH_INTERVAL_MS = 50;
const MAX_EVENTS_PER_WATCH = 200;

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
  private freezeTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private disposed = false;

  constructor() {
    this.registry = new WasmRegistry({
      onInstrumented: (tracked) => this.trace.onInstrumented(tracked),
    });
    this.hooks = new HookStore(this.registry, detectEvalAllowed());
    this.trace = new TraceStore(this.registry, (bytes, modes) => {
      const instrumented = instrumentModule(bytes, modes);
      return {
        bytes: instrumented.bytes,
        importModule: instrumented.importModule,
        importField: instrumented.importField,
        readField: 'on_read',
        armExport: instrumented.armExport,
      };
    });
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
    return { version: AGENT_VERSION, url: location.href, evalAllowed: this.hooks.evalAllowed };
  }

  /**
   * "Why does this tab show no instances?" — every real cause is observable from here:
   * the app never called a patched entry point, it lives in a frame we are not in, or it
   * simply is not a wasm app (JS/canvas).
   */
  diagnose(): PageDiagnostics {
    const stats = patchStats();
    const calls = stats.calls;
    const instances = this.registry.list().length;
    const iframes = readIframes();
    const canvases = document.querySelectorAll('canvas').length;
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
      title: document.title,
      readyState: document.readyState,
      calls,
      agentAgeMs: Date.now() - stats.installedAt,
      instances,
      iframes,
      canvases,
      wasmReferences: wasmReferences(),
      hint,
    };
  }

  listInstances(): InstanceInfo[] {
    return this.registry.list().map((tracked) => this.registry.describe(tracked));
  }

  // ---------------------------------------------------------------- memory

  private access(instanceId: string): { tracked: TrackedInstance; access: MemoryAccess } {
    const tracked = this.registry.get(instanceId);
    if (!tracked) {
      throw new BridgeError('NO_INSTANCE', `unknown instance "${instanceId}"`, {
        known: this.registry.list().map((entry) => entry.id),
      });
    }
    if (!tracked.memory) {
      throw new BridgeError(
        'NO_MEMORY',
        `instance ${instanceId} exposes no WebAssembly.Memory (checked exports and imports)`,
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

  handle(method: string, params: unknown): unknown {
    const p = (params ?? {}) as never;
    switch (method) {
      case 'page.hello':
        return this.info();
      case 'page.listInstances':
        return this.listInstances();
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
  const html = document.documentElement?.outerHTML ?? '';
  const found = html.match(/[^"'\s>]*\.wasm(?:\?[^"'\s>]*)?/g) ?? [];
  return Array.from(new Set(found)).slice(0, 5);
}
