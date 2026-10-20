import { BridgeError, type HookEntry, type HookSpec } from '@wasmcheat/protocol';
import type { ImportRule, TrackedInstance, WasmRegistry } from './registry.js';

type AnyFunction = (...args: unknown[]) => unknown;

export interface HookContext {
  instanceId: string;
  target: 'export' | 'import';
  name: string;
  args: unknown[];
  /** Calls the next layer down (the original export, or the real import). */
  call: (nextArgs?: unknown[]) => unknown;
  /** Result of the most recent `call`, or the value the original returned. */
  lastReturn: unknown;
}

interface HookRecord {
  id: string;
  spec: HookSpec;
  enabled: boolean;
  compiled: ((args: unknown[], ctx: HookContext) => unknown) | null;
  fallbackUsed: boolean;
  calls: number;
  lastArgs: unknown[] | null;
  lastReturn: unknown;
  createdAt: number;
  pending: boolean;
}

interface CachedWrapper {
  version: number;
  original: AnyFunction;
  fn: AnyFunction;
}

/** Detect once whether this realm lets us compile a hook body (page CSP may forbid it). */
export function detectEvalAllowed(): boolean {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return 1')() === 1;
  } catch {
    return false;
  }
}

/**
 * Exports on a live instance are frozen — `Object.getOwnPropertyDescriptor(instance.exports, 'f')`
 * reports `writable: false, configurable: false`, and the exports object is sealed. Assigning
 * over one throws. What *is* possible is shadowing `instance.exports` on the (extensible)
 * `WebAssembly.Instance` object with a live view: each property becomes a getter that asks us
 * which function to hand out. Hooks stay live without re-instantiating, and removing them
 * restores the original functions because the getter simply stops intercepting.
 */
export class HookStore {
  private readonly records = new Map<string, HookRecord>();
  /** instanceId -> export name -> hooks in install order (last installed is outermost). */
  private readonly exportChains = new Map<string, Map<string, HookRecord[]>>();
  private readonly viewRestores = new Map<string, () => void>();
  private readonly wrapperCache = new Map<string, CachedWrapper>();
  private version = 0;
  private nextId = 1;
  /**
   * Unknown until a hook body needs compiling. Probing at start-up cost an error in
   * chrome://extensions on every page that enforces Trusted Types (YouTube is one): the probe is
   * itself a violation there, reported whether or not anyone ever writes a hook.
   */
  private evalState: boolean | undefined;

  constructor(
    private readonly registry: WasmRegistry,
    evalAllowed?: boolean,
  ) {
    this.evalState = evalAllowed;
    this.registry.setExportResolver((instanceId, name, original) => this.resolveExport(instanceId, name, original));
  }

  /** Whether hook bodies compile here; undefined until the first hook asked. */
  get evalAllowed(): boolean | undefined {
    return this.evalState;
  }

  list(): HookEntry[] {
    return [...this.records.values()].map((record) => this.describe(record));
  }

  add(spec: HookSpec): HookEntry {
    const tracked = this.registry.get(spec.instanceId);
    if (!tracked) throw new BridgeError('NO_INSTANCE', `unknown instance "${spec.instanceId}"`);

    if (spec.target === 'export' && !isExportFunction(tracked, spec.name)) {
      throw new BridgeError('BAD_PARAMS', `instance ${tracked.id} has no function export named "${spec.name}"`, {
        exports: Object.keys(tracked.instance.exports ?? {}),
      });
    }

    const record: HookRecord = {
      id: `h${this.nextId++}`,
      spec,
      enabled: true,
      compiled: this.compile(spec),
      fallbackUsed: false,
      calls: 0,
      lastArgs: null,
      lastReturn: undefined,
      createdAt: Date.now(),
      pending: false,
    };

    if (spec.target === 'export') {
      this.ensureExportView(tracked);
      const chains = this.exportChains.get(tracked.id) ?? new Map<string, HookRecord[]>();
      const chain = chains.get(spec.name) ?? [];
      chain.push(record);
      chains.set(spec.name, chain);
      this.exportChains.set(tracked.id, chains);
    } else {
      this.installImportRule(record, tracked);
    }

    this.version++;
    this.records.set(record.id, record);
    return this.describe(record);
  }

  setEnabled(hookId: string, enabled: boolean): HookEntry {
    const record = this.records.get(hookId);
    if (!record) throw new BridgeError('BAD_PARAMS', `unknown hook "${hookId}"`);
    record.enabled = enabled;
    this.version++;
    // The view reads this flag on every property access, so no rebuild is needed;
    // the version bump only refreshes cached wrapper identities.
    return this.describe(record);
  }

  remove(hookId: string): boolean {
    const record = this.records.get(hookId);
    if (!record) return false;
    if (record.spec.target === 'import') this.registry.removeImportRule(record.id);
    const chains = this.exportChains.get(record.spec.instanceId);
    const chain = chains?.get(record.spec.name);
    if (chain) {
      const index = chain.indexOf(record);
      if (index >= 0) chain.splice(index, 1);
      if (chain.length === 0) chains?.delete(record.spec.name);
      if (chains && chains.size === 0) this.exportChains.delete(record.spec.instanceId);
    }
    this.records.delete(hookId);
    this.version++;
    return true;
  }

  removeForInstance(instanceId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.spec.instanceId === instanceId) this.remove(record.id);
    }
    this.exportChains.delete(instanceId);
    const restore = this.viewRestores.get(instanceId);
    if (restore) {
      restore();
      this.viewRestores.delete(instanceId);
    }
    this.version++;
  }

  /** Called by the export view on every property read. */
  resolveExport(instanceId: string, name: string, original: AnyFunction): AnyFunction | null {
    const chain = this.exportChains.get(instanceId)?.get(name);
    if (!chain || chain.length === 0) return null;
    const active = chain.filter((record) => record.enabled);
    if (active.length === 0) return null;

    const cacheKey = `${instanceId}::${name}`;
    const cached = this.wrapperCache.get(cacheKey);
    if (cached && cached.version === this.version && cached.original === original) return cached.fn;

    let current = original;
    for (const record of active) current = this.makeWrapper(record, current);
    this.wrapperCache.set(cacheKey, { version: this.version, original, fn: current });
    return current;
  }

  private makeWrapper(record: HookRecord, inner: AnyFunction): AnyFunction {
    const store = this;
    return function patchedExport(this: unknown, ...args: unknown[]): unknown {
      if (!record.enabled) return inner.apply(this, args);
      return store.invoke(record, inner, args);
    };
  }

  private ensureExportView(tracked: TrackedInstance): void {
    if (this.viewRestores.has(tracked.id)) return;
    const restore = this.registry.installExportView(tracked, (instanceId, name, original) =>
      this.resolveExport(instanceId, name, original),
    );
    this.viewRestores.set(tracked.id, restore);
  }

  private compile(spec: HookSpec): ((args: unknown[], ctx: HookContext) => unknown) | null {
    this.evalState ??= detectEvalAllowed();
    if (!this.evalState) return null;
    try {
      // eslint-disable-next-line no-new-func
      return new Function('args', 'ctx', `"use strict";\n${spec.body}`) as (
        args: unknown[],
        ctx: HookContext,
      ) => unknown;
    } catch (error) {
      throw new BridgeError('BAD_PARAMS', `hook body failed to compile: ${(error as Error).message}`);
    }
  }

  private installImportRule(record: HookRecord, tracked: TrackedInstance): void {
    const [moduleName, importName] = splitImportName(record.spec.name);
    const store = this;
    const rule: ImportRule = {
      hookId: record.id,
      moduleName,
      importName,
      wrap: (original: AnyFunction) =>
        function patchedImport(this: unknown, ...args: unknown[]): unknown {
          if (!record.enabled) return original.apply(this, args);
          return store.invoke(record, original, args);
        },
    };
    this.registry.addImportRule(rule);
    // WebAssembly captures imported funcrefs at instantiation: an instance that is already
    // running can never have an import swapped out. The rule bites the next time this page
    // instantiates a module that imports `moduleName.importName`.
    record.pending = this.registry.importPatchabilityOf(tracked) !== 'live';
  }

  private invoke(record: HookRecord, inner: AnyFunction, args: unknown[]): unknown {
    record.calls++;
    record.lastArgs = cloneForLog(args);
    let callResult: unknown = undefined;
    let called = false;

    const ctx: HookContext = {
      instanceId: record.spec.instanceId,
      target: record.spec.target,
      name: record.spec.name,
      args,
      call: (nextArgs?: unknown[]) => {
        called = true;
        callResult = inner.apply(undefined, nextArgs ?? args);
        record.lastReturn = callResult;
        return callResult;
      },
      lastReturn: undefined,
    };

    let result: unknown;
    if (record.compiled) {
      try {
        result = record.compiled(args, ctx);
      } catch (error) {
        throw new BridgeError('INTERNAL', `hook ${record.id} threw: ${(error as Error)?.message ?? String(error)}`);
      }
    } else {
      record.fallbackUsed = true;
      result = runFallback(record, ctx, args);
      called = true;
    }

    // A body that only observed (`ctx.call(args);` or a bare statement) should pass the
    // original value through instead of silently returning undefined.
    if (result === undefined) {
      result = called ? callResult : inner.apply(undefined, args);
    }
    record.lastReturn = result;
    return result;
  }

  private describe(record: HookRecord): HookEntry {
    return {
      id: record.id,
      instanceId: record.spec.instanceId,
      target: record.spec.target,
      name: record.spec.name,
      enabled: record.enabled,
      body: record.spec.body,
      fallbackUsed: record.fallbackUsed,
      calls: record.calls,
      lastArgs: record.lastArgs,
      lastReturn: record.lastReturn,
      createdAt: record.createdAt,
      pending: record.pending,
    };
  }
}

function runFallback(record: HookRecord, ctx: HookContext, args: unknown[]): unknown {
  const fallback = record.spec.fallback ?? { mode: 'passthrough' as const };
  switch (fallback.mode) {
    case 'replace-return':
      return fallback.value ?? 0;
    case 'offset-result':
      return Number(ctx.call(args)) + (fallback.value ?? 0);
    case 'passthrough':
    default:
      return ctx.call(args);
  }
}

function splitImportName(name: string): [string, string] {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    throw new BridgeError('BAD_PARAMS', `import name must look like "env.foo", got "${name}"`);
  }
  return [name.slice(0, dot), name.slice(dot + 1)];
}

function isExportFunction(tracked: TrackedInstance, name: string): boolean {
  const exportsObject = tracked.instance.exports as unknown as Record<string, unknown>;
  return typeof exportsObject[name] === 'function';
}

/** Hook arguments can be anything; keep the log JSON-safe and bounded. */
function cloneForLog(args: unknown[]): unknown[] {
  return args.slice(0, 16).map((value) => {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') return '[function]';
    if (value && typeof value === 'object') {
      try {
        return JSON.parse(JSON.stringify(value)) as unknown;
      } catch {
        return '[object]';
      }
    }
    return value;
  });
}
