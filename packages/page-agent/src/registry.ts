import { BridgeError, type ExportInfo, type InstanceInfo, type MemoryInfo } from '@wasmcheat/protocol';
import { readFunctionExports } from './wasm-exports.js';

export type ImportObject = Record<string, Record<string, unknown>>;

export type CreatedBy = 'instantiate' | 'instantiateStreaming' | 'new Instance';

export interface TrackedInstance {
  id: string;
  instance: WebAssembly.Instance;
  module: WebAssembly.Module | null;
  moduleHash: string | null;
  /** The imports object actually handed to the engine, after our import rules ran. */
  imports: ImportObject | null;
  memory: WebAssembly.Memory | null;
  memorySource: 'export' | 'import' | 'none';
  createdAt: number;
  createdBy: CreatedBy;
  /** Set when the instance's `exports` getter was shadowed with a live, hookable view. */
  exportViewInstalled?: boolean;
  exportViewRestore?: () => void;
  /** Set when the binary was rewritten so every store calls back into the host. */
  instrumented?: boolean;
  /** wasm function index → export name, for attributing instrumented stores. */
  functionNames?: Record<number, string>;
}

/** What a rewrite added to the module, so the runtime can finish wiring it up. */
export interface InstrumentedBinary {
  bytes: Uint8Array;
  importModule: string;
  importField: string;
  /** Exported function that flips the store checks on. */
  armExport: string;
}

/**
 * Rewrites binaries before the engine sees them, which is the only moment a write watchpoint
 * can be added: a compiled module cannot be changed, and instances cannot observe stores.
 */
export interface Instrumenter {
  /** Returns null when this binary cannot be rewritten (the trace then explains why). */
  rewrite(bytes: Uint8Array): InstrumentedBinary | null;
  /** One store ran inside an armed instance. */
  onStore(funcIndex: number): void;
}

/** A rule registered before an instance is created; applied as imports flow through. */
export interface ImportRule {
  hookId: string;
  /** Import module namespace, e.g. `env`. */
  moduleName: string;
  importName: string;
  wrap: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
}

export type AnyFunction = (...args: unknown[]) => unknown;

/** Returns the function to expose for `name`, or null to hand out the original. */
export type ExportResolver = (instanceId: string, name: string, original: AnyFunction) => AnyFunction | null;

export interface RegistryEvents {
  onInstance?: (instance: TrackedInstance) => void;
  /** Called once an instrumented instance is created and the store checks are on. */
  onInstrumented?: (instance: TrackedInstance) => void;
}

const MEMORY_EXPORT_NAMES = ['memory', '__linear_memory', '__memory', 'mem'];
/**
 * Patching `WebAssembly` is global and irreversible, so the patched entry points live
 * once per realm and fan out to every registry that installed them. That makes repeat
 * injection a no-op instead of stacking wrappers inside wrappers.
 */
interface InstallState {
  patched: boolean;
  registries: WasmRegistry[];
  /** How many times the app tried to create an instance through each patched entry point. */
  calls: { instantiate: number; instantiateStreaming: number; newInstance: number; compile: number };
  installedAt: number;
}

function installState(): InstallState {
  const key = Symbol.for('wasmcheat.install');
  const holder = globalThis as unknown as Record<symbol, InstallState | undefined>;
  holder[key] ??= {
    patched: false,
    registries: [],
    calls: { instantiate: 0, instantiateStreaming: 0, newInstance: 0, compile: 0 },
    installedAt: Date.now(),
  };
  return holder[key]!;
}

/** Diagnostics: was anything even passed through our patches? */
export function patchStats(): { patched: boolean; installedAt: number; calls: InstallState['calls'] } {
  const state = installState();
  return { patched: state.patched, installedAt: state.installedAt, calls: { ...state.calls } };
}

/** FNV-1a over a sample of the bytes. Enough to tell modules apart, cheap on 20 MB files. */
export function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  const step = bytes.length > 262144 ? Math.ceil(bytes.length / 262144) : 1;
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= bytes.length;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class WasmRegistry {
  private readonly instances: TrackedInstance[] = [];
  private readonly moduleBytes = new WeakMap<WebAssembly.Module, { bytes: Uint8Array; hash: string }>();
  private readonly importRules = new Map<string, ImportRule>();
  private nextId = 1;
  private resolver: ExportResolver | null = null;
  private instrumenter: Instrumenter | null = null;

  constructor(private readonly events: RegistryEvents = {}) {}

  /** Arms write tracing for the next instantiation; pass null to stop rewriting. */
  setInstrumenter(instrumenter: Instrumenter | null): void {
    this.instrumenter = instrumenter;
  }

  get hasInstrumenter(): boolean {
    return this.instrumenter !== null;
  }

  bytesFor(module: WebAssembly.Module): Uint8Array | null {
    return this.moduleBytes.get(module)?.bytes ?? null;
  }

  /**
   * Rewrites the bytes for the pending instantiation, or null when nothing should change.
   * Called from the patched entry points, which own both the source and the imports object.
   */
  planInstrumentation(bytes: Uint8Array): { plan: InstrumentedBinary; importsAdd: ImportObject } | null {
    const instrumenter = this.instrumenter;
    if (!instrumenter) return null;
    let plan: InstrumentedBinary | null = null;
    try {
      plan = instrumenter.rewrite(bytes);
    } catch {
      return null;
    }
    if (!plan) return null;
    // The rewritten module calls this on every store: the only channel an engine gives us.
    const importsAdd: ImportObject = {
      [plan.importModule]: {
        [plan.importField]: (funcIndex: number) => instrumenter.onStore(funcIndex),
      },
    };
    return { plan, importsAdd };
  }

  /** Flips the store checks on inside an instance we just instrumented. */
  private armInstrumented(tracked: TrackedInstance, plan: InstrumentedBinary): void {
    const arm = (tracked.instance.exports as Record<string, unknown>)[plan.armExport];
    if (typeof arm !== 'function') return;
    try {
      (arm as (flags: number) => void)(1);
      tracked.instrumented = true;
      this.events.onInstrumented?.(tracked);
    } catch {
      // An engine that refuses the call leaves the checks off, which is a no-op, not damage.
    }
  }

  /** HookStore registers itself here; the export view calls back through it on every read. */
  setExportResolver(resolver: ExportResolver): void {
    this.resolver = resolver;
  }

  /**
   * Replaces `instance.exports` with a live view object whose properties are getters.
   * Returns a function that puts the real (frozen) exports object back.
   */
  installExportView(tracked: TrackedInstance, resolve: ExportResolver): () => void {
    // Already shadowed by an earlier install; the existing view resolves through the
    // registry's resolver, so it covers any hook store attached later.
    if (tracked.exportViewInstalled) return tracked.exportViewRestore ?? (() => undefined);

    const real = tracked.instance.exports as unknown as Record<string, unknown>;
    const view = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(real)) {
      const value = real[key as string];
      const name = String(key);
      if (typeof value === 'function') {
        const fn = value as AnyFunction;
        Object.defineProperty(view, name, {
          enumerable: true,
          configurable: true,
          get: () => resolve(tracked.id, name, fn) ?? fn,
        });
      } else {
        Object.defineProperty(view, name, { enumerable: true, configurable: true, get: () => value });
      }
    }

    const instance = tracked.instance as unknown as Record<string, unknown>;
    const previous = Object.getOwnPropertyDescriptor(instance, 'exports');
    try {
      Object.defineProperty(instance, 'exports', {
        configurable: true,
        enumerable: true,
        get: () => view,
      });
    } catch (error) {
      throw new BridgeError(
        'UNSUPPORTED',
        `can't shadow instance.exports on this engine: ${(error as Error).message}`,
      );
    }
    tracked.exportViewInstalled = true;
    const restore = () => {
      if (previous) Object.defineProperty(instance, 'exports', previous);
      else delete instance.exports;
      tracked.exportViewInstalled = false;
      tracked.exportViewRestore = undefined;
    };
    tracked.exportViewRestore = restore;
    return restore;
  }

  list(): TrackedInstance[] {
    return [...this.instances];
  }

  get(id: string): TrackedInstance | undefined {
    return this.instances.find((entry) => entry.id === id);
  }

  /** Registers an instance the page hands us directly (escape hatch for late attaches). */
  adopt(instance: WebAssembly.Instance, imports?: ImportObject): TrackedInstance {
    const existing = this.instances.find((entry) => entry.instance === instance);
    if (existing) return existing;
    return this.register(instance, null, imports ?? null, 'new Instance');
  }

  addImportRule(rule: ImportRule): void {
    this.importRules.set(rule.hookId, rule);
  }

  removeImportRule(hookId: string): void {
    this.importRules.delete(hookId);
  }

  install(): void {
    const state = installState();
    if (!state.registries.includes(this)) state.registries.push(this);
    if (state.patched) return;
    state.patched = true;
    const registries = state.registries;
    const prepareImportsForAll = (imports?: ImportObject): ImportObject | undefined => {
      let applied = imports;
      for (const registry of registries) applied = registry.prepareImports(applied).applied;
      return applied;
    };
    const registerInAll = (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module | null,
      imports: ImportObject | null,
      createdBy: CreatedBy,
      plans?: Map<WasmRegistry, InstrumentedBinary>,
    ) => {
      for (const registry of registries) registry.register(instance, module, imports, createdBy, plans);
    };

    const mergeImports = (base: ImportObject | undefined, add: ImportObject): ImportObject => {
      const merged: ImportObject = { ...(base ?? {}) };
      for (const [namespace, values] of Object.entries(add)) {
        merged[namespace] = { ...(merged[namespace] ?? {}), ...values };
      }
      return merged;
    };

    /** Bytes of the module the app is about to hand to the engine, when we can get them. */
    function bytesFrom(source: BufferSource | WebAssembly.Module): Uint8Array | null {
      if (isBufferSource(source)) return toBytes(source);
      for (const registry of registries) {
        const bytes = registry.bytesFor(source);
        if (bytes) return bytes;
      }
      return null;
    }

    /**
     * Rewrites the binary for every registry that wants a write watchpoint and layers the
     * callback import in. Rewriting happens here, in the patched entry point, because that is
     * the only moment the module is still bytes we control.
     */
    function instrumentForAll(
      bytes: Uint8Array | null,
      imports: ImportObject | undefined,
    ): { imports: ImportObject | undefined; plans: Map<WasmRegistry, InstrumentedBinary>; bytes: Uint8Array | null } {
      const plans = new Map<WasmRegistry, InstrumentedBinary>();
      if (!bytes) return { imports, plans, bytes: null };
      let applied = imports;
      let rewritten: Uint8Array | null = null;
      for (const registry of registries) {
        const planned = registry.planInstrumentation(bytes);
        if (!planned) continue;
        plans.set(registry, planned.plan);
        rewritten = planned.plan.bytes;
        applied = mergeImports(applied, planned.importsAdd);
      }
      return { imports: applied, plans, bytes: rewritten };
    }

    const Real = {
      instantiate: WebAssembly.instantiate.bind(WebAssembly),
      instantiateStreaming: WebAssembly.instantiateStreaming.bind(WebAssembly),
      compile: WebAssembly.compile.bind(WebAssembly),
      compileStreaming: WebAssembly.compileStreaming.bind(WebAssembly),
      Module: WebAssembly.Module,
      Instance: WebAssembly.Instance,
    };

    async function patchedInstantiate(
      source: BufferSource | WebAssembly.Module,
      imports?: ImportObject,
    ): Promise<WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource> {
      const state = installState();
      state.calls.instantiate += 1;
      const prepared = { applied: prepareImportsForAll(imports) };
      const instrumented = instrumentForAll(bytesFrom(source), prepared.applied);
      const result = await (Real.instantiate as unknown as (
        s: unknown,
        i: unknown,
      ) => Promise<unknown>)(instrumented.bytes ?? source, instrumented.imports);
      if (result instanceof Real.Instance) {
        const module = source instanceof Real.Module ? source : null;
        registerInAll(result, module, instrumented.imports ?? null, 'instantiate', instrumented.plans);
        return result as WebAssembly.Instance;
      }
      const typed = result as WebAssembly.WebAssemblyInstantiatedSource;
      const module = typed.module;
      if (isBufferSource(source)) rememberModuleBytesSafe(module, toBytes(source));
      registerInAll(typed.instance, module, instrumented.imports ?? null, 'instantiate', instrumented.plans);
      return typed;
    }

    async function patchedInstantiateStreaming(
      source: Response | PromiseLike<Response>,
      imports?: ImportObject,
    ): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
      const state = installState();
      state.calls.instantiateStreaming += 1;
      const prepared = { applied: prepareImportsForAll(imports) };
      const response = await source;
      // Clone before the engine consumes the body so we can hash the module later.
      const clone = typeof response?.clone === 'function' ? response.clone() : null;
      // A watchpoint needs the bytes before they compile, so a tracing tab trades streaming
      // compilation for a buffer read. Every other time the response streams untouched.
      let body: Uint8Array | null = null;
      if (clone && registries.some((registry) => registry.hasInstrumenter)) {
        body = new Uint8Array(await clone.arrayBuffer());
      }
      const instrumented = instrumentForAll(body, prepared.applied);
      const typed = instrumented.bytes
        ? ((await (Real.instantiate as unknown as (
            s: unknown,
            i: unknown,
          ) => Promise<WebAssembly.WebAssemblyInstantiatedSource>)(instrumented.bytes, instrumented.imports)) as WebAssembly.WebAssemblyInstantiatedSource)
        : await (Real.instantiateStreaming as unknown as (
            s: unknown,
            i: unknown,
          ) => Promise<WebAssembly.WebAssemblyInstantiatedSource>)(response, instrumented.imports);
      if (instrumented.bytes) rememberModuleBytesSafe(typed.module, instrumented.bytes);
      else if (clone) {
        clone
          .arrayBuffer()
          .then((buffer) => rememberModuleBytesSafe(typed.module, new Uint8Array(buffer)))
          .catch(() => undefined);
      }
      registerInAll(typed.instance, typed.module, instrumented.imports ?? null, 'instantiateStreaming', instrumented.plans);
      return typed;
    }

    async function patchedCompile(source: BufferSource): Promise<WebAssembly.Module> {
      installState().calls.compile += 1;
      const module = await (Real.compile as unknown as (s: unknown) => Promise<WebAssembly.Module>)(source);
      if (isBufferSource(source)) rememberModuleBytesSafe(module, toBytes(source));
      return module;
    }

    async function patchedCompileStreaming(source: Response | PromiseLike<Response>): Promise<WebAssembly.Module> {
      const response = await source;
      const clone = typeof response?.clone === 'function' ? response.clone() : null;
      const module = await (Real.compileStreaming as unknown as (s: unknown) => Promise<WebAssembly.Module>)(response);
      if (clone) {
        clone
          .arrayBuffer()
          .then((buffer) => rememberModuleBytesSafe(module, new Uint8Array(buffer)))
          .catch(() => undefined);
      }
      return module;
    }

    // `new WebAssembly.Instance(...)` cannot be wrapped by a plain function: the engine
    // requires construction, so keep `new.target` semantics and prototype identity.
    function PatchedInstance(
      this: unknown,
      module: WebAssembly.Module,
      imports?: ImportObject,
    ): WebAssembly.Instance {
      if (new.target === undefined) {
        throw new TypeError("Constructor WebAssembly.Instance requires 'new'");
      }
      installState().calls.newInstance += 1;
      const applied = prepareImportsForAll(imports) ?? undefined;
      const instance = Reflect.construct(Real.Instance, [module, applied], Real.Instance) as WebAssembly.Instance;
      registerInAll(instance, module, applied ?? null, 'new Instance');
      return instance;
    }
    PatchedInstance.prototype = Real.Instance.prototype;

    Object.defineProperty(WebAssembly, 'instantiate', { value: patchedInstantiate, writable: true, configurable: true });
    Object.defineProperty(WebAssembly, 'instantiateStreaming', {
      value: patchedInstantiateStreaming,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, 'compile', { value: patchedCompile, writable: true, configurable: true });
    Object.defineProperty(WebAssembly, 'compileStreaming', {
      value: patchedCompileStreaming,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, 'Instance', {
      value: PatchedInstance,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, 'wasmCheatPatched', { value: true, configurable: true });
  }

  /**
   * Clones the imports object only when a rule actually matches, so apps that compare
   * their imports object by identity keep working.
   */
  private prepareImports(imports?: ImportObject): { applied: ImportObject | undefined } {
    if (!imports || this.importRules.size === 0) return { applied: imports };
    let cloned: ImportObject | null = null;
    for (const namespace of Object.keys(imports)) {
      const source = imports[namespace];
      if (!source || typeof source !== 'object') continue;
      for (const [name, value] of Object.entries(source)) {
        if (typeof value !== 'function') continue;
        const rule = this.findRule(namespace, name);
        if (!rule) continue;
        cloned ??= cloneImportObject(imports);
        cloned[namespace]![name] = rule.wrap(value as (...args: unknown[]) => unknown);
      }
    }
    return { applied: cloned ?? imports };
  }

  private findRule(moduleName: string, importName: string): ImportRule | undefined {
    for (const rule of this.importRules.values()) {
      if (rule.moduleName === moduleName && rule.importName === importName) return rule;
    }
    return undefined;
  }

  private register(
    instance: WebAssembly.Instance,
    module: WebAssembly.Module | null,
    imports: ImportObject | null,
    createdBy: CreatedBy,
    plans?: Map<WasmRegistry, InstrumentedBinary>,
  ): TrackedInstance {
    const existing = this.instances.find((entry) => entry.instance === instance);
    if (existing) return existing;

    const exportsObject = (instance.exports ?? {}) as Record<string, unknown>;
    let memory: WebAssembly.Memory | null = null;
    let memorySource: 'export' | 'import' | 'none' = 'none';

    for (const candidate of MEMORY_EXPORT_NAMES) {
      const value = exportsObject[candidate];
      if (value instanceof WebAssembly.Memory) {
        memory = value;
        memorySource = 'export';
        break;
      }
    }
    if (!memory) {
      for (const value of Object.values(exportsObject)) {
        if (value instanceof WebAssembly.Memory) {
          memory = value;
          memorySource = 'export';
          break;
        }
      }
    }
    if (!memory && imports) {
      for (const namespace of Object.values(imports)) {
        if (!namespace || typeof namespace !== 'object') continue;
        for (const value of Object.values(namespace)) {
          if (value instanceof WebAssembly.Memory) {
            memory = value;
            memorySource = 'import';
            break;
          }
        }
        if (memory) break;
      }
    }

    const meta = module ? this.moduleBytes.get(module) : undefined;
    const tracked: TrackedInstance = {
      id: `w${this.nextId++}`,
      instance,
      module,
      moduleHash: meta?.hash ?? null,
      imports,
      memory,
      memorySource,
      createdAt: Date.now(),
      createdBy,
    };
    this.instances.push(tracked);

    // Install the hookable exports view now, before the caller ever reads `instance.exports`,
    // so anything the app caches is already the live view.
    if (this.resolver) {
      try {
        this.installExportView(tracked, (id, name, original) => this.resolver!(id, name, original));
      } catch {
        // A non-extensible instance simply can't be hooked; reads still work.
      }
    }

    this.events.onInstance?.(tracked);

    const plan = plans?.get(this);
    if (plan) {
      // Names come from the instrumented module's own export section, so they match the
      // indices the store callbacks report.
      tracked.functionNames = readFunctionExports(plan.bytes);
      this.armInstrumented(tracked, plan);
    }

    return tracked;
  }

  moduleBytesFor(module: WebAssembly.Module | null): Uint8Array | null {
    if (!module) return null;
    return this.moduleBytes.get(module)?.bytes ?? null;
  }

  /** Public so the shared patched entry points can forward captured module bytes here. */
  rememberBytes = (module: WebAssembly.Module, bytes: Uint8Array): void => {
    if (!this.moduleBytes.has(module)) {
      // Keep a private copy: the caller's buffer may be reused or detached.
      const copy = bytes.slice();
      this.moduleBytes.set(module, { bytes: copy, hash: hashBytes(copy) });
    }
  };

  describe(tracked: TrackedInstance): InstanceInfo {
    return {
      id: tracked.id,
      // Resolved lazily: streaming instantiation hashes the module body asynchronously.
      moduleHash: (tracked.module && this.moduleBytes.get(tracked.module)?.hash) ?? tracked.moduleHash,
      createdBy: tracked.createdBy,
      memoryResolved: tracked.memory !== null,
      memory: tracked.memory ? describeMemory(tracked.memory) : null,
      exports: describeExports(tracked.instance),
      createdAt: tracked.createdAt,
      importPatchability: this.importPatchabilityOf(tracked),
    };
  }

  importPatchabilityOf(tracked: TrackedInstance): 'live' | 'next-instantiation' | 'none' {
    // WebAssembly binds imported functions at instantiation: an already-running instance
    // can never have an import swapped out. A rule only takes effect the next time the
    // page instantiates a matching module, which is what "next-instantiation" reports.
    return tracked.imports ? 'next-instantiation' : 'none';
  }
}

function cloneImportObject(imports: ImportObject): ImportObject {
  const cloned: ImportObject = {};
  for (const [namespace, value] of Object.entries(imports)) {
    cloned[namespace] = value && typeof value === 'object' ? { ...value } : (value as Record<string, unknown>);
  }
  return cloned;
}

function isBufferSource(value: unknown): value is BufferSource {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function rememberModuleBytesSafe(module: WebAssembly.Module, bytes: Uint8Array): void {
  for (const registry of installState().registries) registry.rememberBytes(module, bytes);
}

export function describeExports(instance: WebAssembly.Instance): ExportInfo[] {
  const exportsObject = (instance.exports ?? {}) as Record<string, unknown>;
  return Object.entries(exportsObject).map(([name, value]) => {
    if (typeof value === 'function') {
      return { name, kind: 'function' as const, arity: (value as Function).length ?? null };
    }
    if (value instanceof WebAssembly.Memory) return { name, kind: 'memory' as const, arity: null };
    if (value instanceof WebAssembly.Table) return { name, kind: 'table' as const, arity: null };
    if (value instanceof WebAssembly.Global) return { name, kind: 'global' as const, arity: null };
    return { name, kind: 'global' as const, arity: null };
  });
}

export function describeMemory(memory: WebAssembly.Memory): MemoryInfo {
  return {
    byteLength: memory.buffer.byteLength,
    maxByteLength: null,
    growable: true,
  };
}

function toBytes(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}
