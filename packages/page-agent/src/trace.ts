import {
  BridgeError,
  formatAddress,
  parseAddress,
  type TraceArmOptions,
  type ValueType,
  type WriteTraceHit,
  type WriteTraceStatus,
} from '@wasmcheat/protocol';
import { MemoryAccess } from './memory.js';
import type { InstrumentedBinary, TrackedInstance, WasmRegistry } from './registry.js';

export type BinaryRewriter = (bytes: Uint8Array) => InstrumentedBinary | null;

const DEFAULT_MAX_HITS = 50;

/**
 * Arming survives a reload because the intent is written to `sessionStorage`.
 *
 * Reloading is how a watchpoint gets installed, and the page agent runs at `document_start`,
 * before the app's own scripts — which is the only moment early enough to instrument the
 * module before it is compiled. So the intent has to live in the document itself, not in the
 * extension: `sessionStorage` is per-origin, survives exactly one reload, and is wiped when the
 * tab closes.
 */
const STORAGE_KEY = 'wasmcheat.trace';

/**
 * Write watchpoints.
 *
 * WebAssembly reports nothing when a store executes, so there is no way to ask a live instance
 * "who wrote here?". The answer has to be built into the module: every store gains a guarded
 * call back into this class, which diffs the watched address and, when it moved, records the
 * function index that the call site passed in.
 *
 * The consequence is honest and unavoidable: a watchpoint can only be installed on a module
 * that has not been compiled yet, so arming takes effect at the next instantiation (the tools
 * reload the tab). Arming a page that is already running reports that instead of pretending.
 */
export class TraceStore {
  private hitList: WriteTraceHit[] = [];
  private dropped = 0;
  private armed = false;
  private installed = false;
  private note: string | undefined;
  private watch: { offset: number; type: ValueType; last: number } | null = null;
  private current: TrackedInstance | null = null;
  private functionNames: Record<number, string> = {};
  private maxHits = DEFAULT_MAX_HITS;
  private armedInstanceId = 'w1';

  constructor(
    private readonly registry: WasmRegistry,
    private readonly rewrite: BinaryRewriter,
  ) {}

  status(): WriteTraceStatus {
    return {
      armed: this.armed,
      installed: this.installed,
      hits: this.hitList.slice(),
      dropped: this.dropped,
      ...(this.watch ? { address: this.describeAddress(), type: this.watch.type } : {}),
      ...(this.current ? { instanceId: this.current.id } : {}),
      ...(this.note ? { note: this.note } : {}),
    };
  }

  arm(options: TraceArmOptions): WriteTraceStatus {
    const address = parseAddress(options.address);
    const type = options.type ?? 'i32';
    // Re-arming the same watchpoint (a reload re-arms it, and the extension may ask again)
    // must not wipe the hits the page already produced.
    if (
      this.armed &&
      this.installed &&
      this.watch &&
      this.watch.offset === address.offset &&
      this.watch.type === type
    ) {
      return this.status();
    }
    persist(options);
    this.hitList = [];
    this.dropped = 0;
    this.armed = true;
    this.installed = false;
    this.note = undefined;
    this.maxHits = Math.max(1, options.maxHits ?? DEFAULT_MAX_HITS);
    this.watch = { offset: address.offset, type, last: 0 };
    this.armedInstanceId = address.instanceId;
    this.current = null;
    this.registry.setInstrumenter({
      rewrite: (bytes) => this.rewrite(bytes),
      onStore: (funcIndex) => this.onStore(funcIndex),
    });

    // An instance compiled before arming can never report stores: say so once, plainly.
    const live = this.registry.list();
    if (live.length > 0) {
      this.note =
        'this page already instantiated its module, so the watchpoint cannot attach to it; ' +
        'the next instantiation is instrumented (reload the tab to arm it now)';
    }
    return this.status();
  }

  stop(): WriteTraceStatus {
    persist(null);
    this.armed = false;
    this.installed = false;
    this.watch = null;
    this.current = null;
    this.registry.setInstrumenter(null);
    return this.status();
  }

  hits(limit = DEFAULT_MAX_HITS): WriteTraceStatus {
    const capped = Math.max(1, limit);
    return { ...this.status(), hits: this.hitList.slice(0, capped) };
  }

  clear(): WriteTraceStatus {
    this.hitList = [];
    this.dropped = 0;
    if (this.current) this.watchState();
    return this.status();
  }

  /** The registry tells us when an instrumented instance is ready to be watched. */
  onInstrumented(tracked: TrackedInstance): void {
    if (!this.armed || !this.watch) return;
    this.current = tracked;
    this.installed = true;
    this.functionNames = tracked.functionNames ?? {};
    this.watchState();
    this.note = undefined;
  }

  /** Drops state for instances that went away with a navigation or a hook removal. */
  forget(instanceId: string): void {
    if (this.current?.id !== instanceId) return;
    this.current = null;
    this.installed = false;
  }

  private watchState(): void {
    if (!this.watch) return;
    const access = this.access();
    this.watch.last = access.read(this.watch.offset, this.watch.type);
  }

  private onStore(funcIndex: number): void {
    if (!this.armed || !this.watch || !this.current) return;
    const access = this.access();
    const value = access.read(this.watch.offset, this.watch.type);
    if (value === this.watch.last) return;
    const previous = this.watch.last;
    this.watch.last = value;
    if (this.hitList.length >= this.maxHits) {
      this.dropped += 1;
      return;
    }
    const name = this.functionNames[funcIndex];
    this.hitList.push({
      at: Date.now(),
      funcIndex,
      ...(name ? { funcName: name } : {}),
      address: this.describeAddress(),
      previous,
      value,
    });
  }

  private access(): MemoryAccess {
    if (!this.current?.memory) {
      throw new BridgeError('NO_MEMORY', 'the instrumented instance exposes no memory');
    }
    return new MemoryAccess(this.current.memory);
  }

  private describeAddress(): string {
    if (!this.watch) return '';
    return formatAddress({ instanceId: this.current?.id ?? this.armedInstanceId, offset: this.watch.offset });
  }
}

function persist(options: TraceArmOptions | null): void {
  try {
    if (options) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (sandboxed frame, blocked cookies). The watchpoint still works
    // for the current document; it just cannot survive a reload.
  }
}

/**
 * Re-arms a watchpoint recorded by an earlier document. Called once, as soon as the agent boots,
 * which is early enough that the app's module has not been compiled yet.
 */
export function restoreTrace(store: TraceStore): WriteTraceStatus | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const options = JSON.parse(raw) as TraceArmOptions;
    if (typeof options?.address !== 'string') return null;
    return store.arm(options);
  } catch {
    return null;
  }
}
