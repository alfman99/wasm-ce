import { describe, expect, it } from 'vitest';
import { BridgeError } from '@wasmcheat/protocol';
import { instrumentModule, type InstrumentedModule } from '../../packages/wasm-instrument/src/index';
import {
  buildLoadModule,
  buildSimdModule,
  buildStartModule,
  buildStoreModule,
  buildTableModule,
} from '../helpers/wasm-builder';

interface StoreApi {
  store_at(addr: number, value: number): void;
  load_at(addr: number): number;
  tick(): void;
  memory: WebAssembly.Memory;
}

interface ArmedStoreApi extends StoreApi {
  __wc_arm(flags: number): void;
}

interface LoadApi {
  read_at(addr: number): number;
  read64_at(addr: number): bigint;
  bump(): number;
  memory: WebAssembly.Memory;
  __wc_arm(flags: number): void;
}

interface StartExports {
  peek(addr: number): number;
  memory: WebAssembly.Memory;
}

interface TableExports {
  write_via_table(addr: number): void;
  write_direct(addr: number, value: number): void;
  peek(addr: number): number;
  memory: WebAssembly.Memory;
  __wc_arm(flags: number): void;
}

interface Harness {
  instance: WebAssembly.Instance;
  /** Function indices pushed by the injected store callback, in call order. */
  calls: number[];
  /** Addresses and function indices pushed by the injected read callback, in call order. */
  reads: { addr: number; func: number }[];
}

function instantiateModule(instrumented: InstrumentedModule): Harness {
  const calls: number[] = [];
  const reads: { addr: number; func: number }[] = [];
  const imports = {
    [instrumented.importModule]: {
      [instrumented.importField]: (functionIndex: number): void => {
        calls.push(functionIndex);
      },
      // Offered even when the module does not import it: the engine ignores extras.
      on_read: (addr: number, func: number): void => {
        reads.push({ addr, func });
      },
    },
  };
  const module = new WebAssembly.Module(instrumented.bytes);
  return { instance: new WebAssembly.Instance(module, imports), calls, reads };
}

/** The callback fields the instrumented module actually declares, straight from the engine. */
function importNames(instrumented: InstrumentedModule): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(instrumented.bytes)).map((entry) => entry.name);
}

/** The engine's export object is untyped beyond `ExportValue`; the call sites know the shape. */
function exportsOf<T>(instance: WebAssembly.Instance): T {
  return instance.exports as unknown as T;
}

/**
 * The function index published as `name` by the module's own export section — the same lookup a
 * host does to turn a reported index into a name.
 */
function functionIndex(instrumented: InstrumentedModule, name: string): number {
  const index = readFunctionExports(instrumented.bytes).get(name);
  if (index === undefined) throw new Error(`instrumented module does not export the function ${name}`);
  return index;
}

/** Reads the instrumented module's own export section, which is what a host uses for names. */
function readFunctionExports(bytes: Uint8Array): Map<string, number> {
  const names = new Map<string, number>();
  let offset = 8;

  const readU32 = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset] ?? 0;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };

  while (offset < bytes.length) {
    const sectionId = bytes[offset] ?? 0;
    offset += 1;
    const size = readU32();
    const end = offset + size;
    if (sectionId !== 7) {
      offset = end;
      continue;
    }

    const count = readU32();
    for (let entry = 0; entry < count; entry += 1) {
      const nameLength = readU32();
      let name = '';
      for (let index = 0; index < nameLength; index += 1) {
        name += String.fromCharCode(bytes[offset] ?? 0);
        offset += 1;
      }
      const kind = bytes[offset] ?? 0;
      offset += 1;
      const index = readU32();
      if (kind === 0x00) names.set(name, index);
    }
    return names;
  }

  return names;
}

/**
 * Entries the instrumented module's type section declares. A probe signature the module already
 * has must be reused rather than appended, and this is the only way to see that from outside.
 */
function typeSectionCount(bytes: Uint8Array): number {
  let offset = 8;
  const readU32 = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset] ?? 0;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };

  while (offset < bytes.length) {
    const sectionId = bytes[offset] ?? 0;
    offset += 1;
    const size = readU32();
    const end = offset + size;
    if (sectionId === 1) return readU32();
    offset = end;
  }
  return 0;
}

function captureRejection(run: () => unknown): BridgeError {
  try {
    run();
  } catch (error) {
    if (error instanceof BridgeError) return error;
    throw error;
  }
  throw new Error('expected the rewriter to reject the module');
}

describe('instrumentModule', () => {
  it('rewrites every store into a module the engine validates', () => {
    const source = buildStoreModule();
    const instrumented = instrumentModule(source);

    expect(instrumented.importModule).toBe('__wasmcheat');
    expect(instrumented.importField).toBe('on_store');
    expect(instrumented.armExport).toBe('__wc_arm');
    expect(instrumented.functionCount).toBe(3);
    expect(instrumented.storeCount).toBe(3);
    expect(instrumented.bytes.length).toBeGreaterThan(source.length);
    // Compiling walks every index, body size and section length the rewriter recomputed.
    expect(() => new WebAssembly.Module(instrumented.bytes)).not.toThrow();
  });

  it('stays silent and behaves like the original module while disarmed', () => {
    const plain = exportsOf<StoreApi>(new WebAssembly.Instance(new WebAssembly.Module(buildStoreModule())));
    const instrumented = instrumentModule(buildStoreModule());
    const { instance, calls } = instantiateModule(instrumented);
    const exports = exportsOf<ArmedStoreApi>(instance);

    for (const run of [plain, exports]) {
      run.store_at(0x100, 42);
      run.tick();
    }

    expect(calls).toEqual([]);
    expect(exports.load_at(0x100)).toBe(42);
    expect(exports.load_at(0x10)).toBe(1);
    expect(exports.load_at(0x20)).toBe(2);
    expect(new Uint8Array(exports.memory.buffer).slice(0x10, 0x30)).toEqual(
      new Uint8Array(plain.memory.buffer).slice(0x10, 0x30),
    );
  });

  it('reports the storing function while armed', () => {
    const instrumented = instrumentModule(buildStoreModule());
    const { instance, calls } = instantiateModule(instrumented);
    const exports = exportsOf<ArmedStoreApi>(instance);
    const storeAtIndex = functionIndex(instrumented, 'store_at');
    const tickIndex = functionIndex(instrumented, 'tick');

    // Two callback imports take slots 0 and 1, pushing `store_at` (was 0) to 2 and `tick` to 4.
    expect(storeAtIndex).toBe(2);
    expect(tickIndex).toBe(4);

    exports.__wc_arm(1);

    exports.store_at(0x100, 42);
    exports.store_at(0x104, 7);
    expect(calls).toEqual([storeAtIndex, storeAtIndex]);
    expect(exports.load_at(0x104)).toBe(7);

    calls.length = 0;
    exports.tick();
    expect(calls).toEqual([tickIndex, tickIndex]);
    expect(tickIndex).not.toBe(storeAtIndex);
  });

  it('stops reporting after disarm', () => {
    const instrumented = instrumentModule(buildStoreModule());
    const { instance, calls } = instantiateModule(instrumented);
    const exports = exportsOf<ArmedStoreApi>(instance);

    exports.__wc_arm(1);
    exports.store_at(0x100, 1);
    expect(calls).toHaveLength(1);

    exports.__wc_arm(0);
    exports.store_at(0x100, 2);
    exports.tick();

    expect(calls).toHaveLength(1);
    expect(exports.load_at(0x100)).toBe(2);
  });

  it('renumbers the start section so the start function still runs', () => {
    const instrumented = instrumentModule(buildStartModule());
    // Function slot 0 is the callback import, so a stale start index fails instantiation.
    const { instance, calls } = instantiateModule(instrumented);

    expect(instrumented.storeCount).toBe(1);
    expect(exportsOf<StartExports>(instance).peek(0)).toBe(7);
    expect(calls).toEqual([]);
  });

  it('keeps table calls pointing at the right function and reports its index', () => {
    const instrumented = instrumentModule(buildTableModule());
    const { instance, calls } = instantiateModule(instrumented);
    const exports = exportsOf<TableExports>(instance);
    const writeDirectIndex = functionIndex(instrumented, 'write_direct');

    // Both defined functions moved by the number of callback imports: `write_via_table` from 0
    // to 2 and `write_direct` from 1 to 3.
    expect(functionIndex(instrumented, 'write_via_table')).toBe(2);
    expect(writeDirectIndex).toBe(3);

    // A stale element index would either trap on the type check or call the wrong function.
    exports.write_via_table(0x80);
    expect(exports.peek(0x80)).toBe(42);
    expect(calls).toEqual([]);

    exports.__wc_arm(1);

    exports.write_via_table(0x84);
    expect(exports.peek(0x84)).toBe(42);
    expect(calls).toEqual([writeDirectIndex]);

    calls.length = 0;
    exports.write_direct(0x88, 5);
    expect(exports.peek(0x88)).toBe(5);
    expect(calls).toEqual([writeDirectIndex]);
  });

  it('rejects opcodes it cannot walk instead of emitting a corrupt module', () => {
    const error = captureRejection(() => instrumentModule(buildSimdModule()));

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('0xFD');
  });

  it('wraps every load without changing what the module returns', () => {
    const instrumented = instrumentModule(buildLoadModule());
    const { instance } = instantiateModule(instrumented);
    const exports = exportsOf<LoadApi>(instance);

    // read_at, read64_at and bump each hold exactly one load, so each gets exactly one probe.
    expect(instrumented.readCount).toBe(3);
    expect(instrumented.probeCount).toBe(3);
    expect(instrumented.storeCount).toBe(1);
    expect(instrumented.functionCount).toBe(3);

    // The probe passes the address through, so every value is the one the plain module returns.
    expect(exports.read_at(0x20)).toBe(0xdeadbeef | 0);
    expect(exports.read_at(0x24)).toBe(0x44332211 | 0);
    expect(exports.read64_at(0x28)).toBe(0x0807060504030201n);
    expect(exports.bump()).toBe(7);
    expect(exports.read_at(0x30)).toBe(7);

    // Three original types plus the two callback types: the probe signature `(i32)->(i32)`
    // already exists as type 0, so a deduplicating rewriter appends nothing for it.
    expect(typeSectionCount(instrumented.bytes)).toBe(5);
  });

  it('reports the address and function of each armed load', () => {
    const instrumented = instrumentModule(buildLoadModule());
    const { instance, reads } = instantiateModule(instrumented);
    const exports = exportsOf<LoadApi>(instance);
    // `read_at` was defined function 0 and follows the two callback imports.
    const readAtIndex = functionIndex(instrumented, 'read_at');
    expect(readAtIndex).toBe(2);
    expect(functionIndex(instrumented, 'read64_at')).toBe(3);
    expect(functionIndex(instrumented, 'bump')).toBe(4);

    exports.__wc_arm(1);

    expect(exports.read_at(0x20)).toBe(0xdeadbeef | 0);
    expect(reads).toEqual([{ addr: 0x20, func: readAtIndex }]);

    reads.length = 0;
    expect(exports.read_at(0x24)).toBe(0x44332211 | 0);
    expect(reads).toEqual([{ addr: 0x24, func: readAtIndex }]);
  });

  it('reports nothing before the module is armed, and nothing after a disarm', () => {
    const instrumented = instrumentModule(buildLoadModule());
    const { instance, reads } = instantiateModule(instrumented);
    const exports = exportsOf<LoadApi>(instance);

    exports.read_at(0x20);
    exports.read64_at(0x28);
    exports.bump();
    expect(reads).toEqual([]);

    exports.__wc_arm(1);
    exports.read_at(0x20);
    expect(reads).toHaveLength(1);

    exports.__wc_arm(0);
    reads.length = 0;
    exports.read_at(0x24);
    expect(reads).toEqual([]);
  });

  it('leaves the direction it was told to skip completely alone', () => {
    const source = buildStoreModule();

    const noReads = instrumentModule(source, { reads: false });
    expect(noReads.readCount).toBe(0);
    expect(noReads.probeCount).toBe(0);
    expect(noReads.storeCount).toBe(3);
    expect(importNames(noReads)).toEqual(['on_store']);

    const noWrites = instrumentModule(source, { writes: false });
    expect(noWrites.storeCount).toBe(0);
    // `load_at` holds the module's single load.
    expect(noWrites.readCount).toBe(1);
    expect(importNames(noWrites)).toEqual(['on_read']);

    const skipped = instantiateModule(noWrites);
    const exports = exportsOf<ArmedStoreApi>(skipped.instance);
    exports.__wc_arm(1);
    exports.store_at(0x100, 11);
    expect(skipped.calls).toEqual([]);
    expect(exports.load_at(0x100)).toBe(11);
    expect(skipped.reads).toEqual([{ addr: 0x100, func: functionIndex(noWrites, 'load_at') }]);
  });

  it('reports stores and loads together, each with its own function index', () => {
    const storeInstrumented = instrumentModule(buildStoreModule());
    const stores = instantiateModule(storeInstrumented);
    const storeExports = exportsOf<ArmedStoreApi>(stores.instance);
    const storeAtIndex = functionIndex(storeInstrumented, 'store_at');
    const loadAtIndex = functionIndex(storeInstrumented, 'load_at');

    storeExports.__wc_arm(1);
    storeExports.store_at(0x100, 5);
    expect(stores.calls).toEqual([storeAtIndex]);
    // Storing reports writes only: no probe sits in `store_at`.
    expect(stores.reads).toEqual([]);

    expect(storeExports.load_at(0x100)).toBe(5);
    expect(stores.reads).toEqual([{ addr: 0x100, func: loadAtIndex }]);
    expect(stores.calls).toEqual([storeAtIndex]);

    // `bump` is the function that does both, so it reports twice under the same index.
    const loadInstrumented = instrumentModule(buildLoadModule());
    const loads = instantiateModule(loadInstrumented);
    const loadExports = exportsOf<LoadApi>(loads.instance);
    const bumpIndex = functionIndex(loadInstrumented, 'bump');

    loadExports.__wc_arm(1);
    expect(loadExports.bump()).toBe(7);
    expect(loads.calls).toEqual([bumpIndex]);
    expect(loads.reads).toEqual([{ addr: 0x30, func: bumpIndex }]);
  });

  it('keeps an i64 result intact across the probe', () => {
    const instrumented = instrumentModule(buildLoadModule());
    const { instance, reads } = instantiateModule(instrumented);
    const exports = exportsOf<LoadApi>(instance);

    exports.__wc_arm(1);
    const value = exports.read64_at(0x28);

    // A probe that ate or widened the i64 would either trap on the load or shorten the value.
    expect(typeof value).toBe('bigint');
    expect(value).toBe(0x0807060504030201n);
    expect(reads).toEqual([{ addr: 0x28, func: functionIndex(instrumented, 'read64_at') }]);
  });
});
