import {
  BridgeError,
  formatAddress,
  parseAddress,
  type TraceArmOptions,
  type TraceKind,
  type ValueType,
  type WriteTraceHit,
  type WriteTraceStatus,
} from '@wasmcheat/protocol';
import { MemoryAccess } from './memory.js';
import type { InstrumentModes, InstrumentedBinary, TrackedInstance, WasmRegistry } from './registry.js';

export type BinaryRewriter = (bytes: Uint8Array, modes: InstrumentModes) => InstrumentedBinary | null;

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
 * Read and write watchpoints.
 *
 * WebAssembly reports nothing when a store or a load executes, so there is no way to ask a live
 * instance "who touched this address?". The answer has to be built into the module: every store
 * gains a guarded call back into this class, and every load gains a guarded identity call that
 * hands us the address it is about to read. Both carry the index of the function they were
 * compiled into, which is what makes the attribution exact.
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
  private kind: TraceKind = 'write';
  /** Hits per function, counted even after `maxHits` stops the list from growing. */
  private readonly counts = new Map<number, number>();
  private current: TrackedInstance | null = null;
  private functionNames: Record<number, string> = {};
  private maxHits = DEFAULT_MAX_HITS;
  private armedInstanceId = 'w1';
  private hitListener: ((hit: WriteTraceHit) => void) | null = null;

  constructor(
    private readonly registry: WasmRegistry,
    private readonly rewrite: BinaryRewriter,
    /**
     * Watchpoints and function patches share one rewrite pass, so neither store may install the
     * instrumenter itself: both ask the runtime to compose the current plan instead.
     */
    private readonly onWiringChange: () => void,
  ) {}

  status(): WriteTraceStatus {
    return {
      armed: this.armed,
      installed: this.installed,
      hits: this.hitList.slice(),
      dropped: this.dropped,
      functions: [...this.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([funcIndex, hits]) => {
          const name = this.functionNames[funcIndex];
          return { funcIndex, hits, ...(name ? { name } : {}) };
        }),
      ...(this.watch ? { address: this.describeAddress(), type: this.watch.type, kind: this.kind } : {}),
      ...(this.current ? { instanceId: this.current.id } : {}),
      ...(this.note ? { note: this.note } : {}),
    };
  }

  arm(options: TraceArmOptions): WriteTraceStatus {
    const address = parseAddress(options.address);
    const type = options.type ?? 'i32';
    const kind: TraceKind = options.kind ?? 'write';
    // Re-arming the same watchpoint (a reload re-arms it, and the extension may ask again)
    // must not wipe the hits the page already produced.
    if (
      this.armed &&
      this.installed &&
      this.watch &&
      this.watch.offset === address.offset &&
      this.watch.type === type &&
      this.kind === kind
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
    this.kind = kind;
    this.counts.clear();
    this.watch = { offset: address.offset, type, last: 0 };
    this.armedInstanceId = address.instanceId;
    this.current = null;
    this.onWiringChange();

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
    this.counts.clear();
    this.onWiringChange();
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

  /**
   * A hit that was just recorded, so a caller can be told about the first one instead of reading
   * the status until `hits` is non-empty. Dropped hits are not announced: the message would only
   * carry what `dropped` already counts.
   */
  onHit(listener: (hit: WriteTraceHit) => void): void {
    this.hitListener = listener;
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

  /**
   * A load of `address` about to happen. Every load in the module reports here, so the watched
   * address is the only thing worth doing work for.
   */
  /** What the rewriter has to do for the current watchpoint, or null when disarmed. */
  modes(): InstrumentModes | null {
    if (!this.armed) return null;
    return { reads: this.kind === 'read', writes: this.kind === 'write' };
  }

  /** Called by the instrumenter the runtime composed (see `refreshInstrumenter`). */
  handleStore(funcIndex: number): void {
    this.record(funcIndex);
  }

  handleRead(address: number, funcIndex: number): void {
    this.onRead(address, funcIndex);
  }

  private onRead(address: number, funcIndex: number): void {
    if (!this.watch || address !== this.watch.offset) return;
    this.record(funcIndex);
  }

  private record(funcIndex: number): void {
    if (!this.armed || !this.watch || !this.current) return;
    const access = this.access();
    const value = access.read(this.watch.offset, this.watch.type);
    // A store that writes the same value still ran, but reporting it as a write would be noise
    // for the "changed" question this answers; reads carry no such ambiguity.
    if (this.kind === 'write' && value === this.watch.last) return;
    const previous = this.watch.last;
    this.watch.last = value;
    this.counts.set(funcIndex, (this.counts.get(funcIndex) ?? 0) + 1);
    if (this.hitList.length >= this.maxHits) {
      this.dropped += 1;
      return;
    }
    const name = this.functionNames[funcIndex];
    const hit: WriteTraceHit = {
      at: Date.now(),
      kind: this.kind,
      funcIndex,
      ...(name ? { funcName: name } : {}),
      address: this.describeAddress(),
      previous,
      value,
    };
    this.hitList.push(hit);
    this.hitListener?.(hit);
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
