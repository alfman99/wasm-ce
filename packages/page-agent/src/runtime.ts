import {
  BridgeError,
  type Address,
  type FreezeEntry,
  type HookEntry,
  type HookSpec,
  type InstanceInfo,
  type PageAgentInfo,
  type ReadResult,
  type ScanMode,
  type ScanOptions,
  type ValueType,
  type WatchEntry,
  type WatchEvent,
  type WriteResult,
  VALUE_TYPE_BYTES,
} from '@wasmcheat/protocol';
import { MemoryAccess } from './memory.js';
import { WasmRegistry, type TrackedInstance } from './registry.js';
import { ScanStore } from './scanner.js';
import { HookStore, detectEvalAllowed } from './hooks.js';

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
  readonly channelId = randomId();

  private readonly freezes = new Map<string, FreezeRecord>();
  private readonly watches = new Map<string, WatchRecord>();
  private freezeTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private disposed = false;

  constructor() {
    this.registry = new WasmRegistry();
    this.hooks = new HookStore(this.registry, detectEvalAllowed());
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

  scanNext(params: { scanId: string; mode: ScanMode; value?: number; tolerance?: number }): ReturnType<ScanStore['narrow']> {
    const session = this.scans.get(params.scanId);
    const { access } = this.access(session.instanceId);
    return this.scans.narrow(access, params.scanId, params.mode, {
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
      case 'page.read':
        return this.read(p);
      case 'page.write':
        return this.write(p);
      case 'page.scan.begin':
        return this.scanBegin(p);
      case 'page.scan.next':
        return this.scanNext(p);
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
