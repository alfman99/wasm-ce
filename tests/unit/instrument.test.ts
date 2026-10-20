import { describe, expect, it } from 'vitest';
import { BridgeError } from '@wasmcheat/protocol';
import { instrumentModule, type InstrumentedModule } from '../../packages/wasm-instrument/src/index';
import {
  buildAtomicModule,
  buildLoadModule,
  buildOpcodeModule,
  buildPatchModule,
  buildRawModule,
  buildSimdLaneModule,
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

interface SimdApi {
  copy_v128(src: number, dst: number): void;
  add_vec(addr: number): number;
  memory: WebAssembly.Memory;
}

interface ArmedSimdApi extends SimdApi {
  __wc_arm(flags: number): void;
}

interface SimdLaneApi {
  copy_lane(src: number, dst: number): void;
  memory: WebAssembly.Memory;
  __wc_arm(flags: number): void;
}

interface AtomicApi {
  atomic_store(addr: number, value: number): void;
  atomic_load(addr: number): number;
  atomic_load16(addr: number): number;
  memory: WebAssembly.Memory;
  __wc_arm(flags: number): void;
}

interface TableExports {
  write_via_table(addr: number): void;
  write_direct(addr: number, value: number): void;
  peek(addr: number): number;
  memory: WebAssembly.Memory;
  __wc_arm(flags: number): void;
}

interface PatchExports {
  add(left: number, right: number): number;
  score(): number;
  flag(): number;
  noop(): void;
  big(): bigint;
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

/** A short ASCII name as the binary format encodes it: length byte, then the characters. */
function ascii(value: string): number[] {
  return [value.length, ...Array.from(value, (character) => character.charCodeAt(0))];
}

/** One code-section entry: size, then the local groups and instructions it was given, then `end`. */
function codeBody(locals: number[], instructions: number[]): number[] {
  const body = [...locals, ...instructions, 0x0b];
  return [body.length, ...body];
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

  it('instruments atomic loads and stores like their non-atomic forms', () => {
    const instrumented = instrumentModule(buildAtomicModule());
    // One store and two loads, each treated the way `i32.store` and `i32.load` would be.
    expect(instrumented.storeCount).toBe(1);
    expect(instrumented.readCount).toBe(2);
    expect(instrumented.probeCount).toBe(2);
    expect(instrumented.unprobed).toEqual([]);

    const { instance, calls, reads } = instantiateModule(instrumented);
    const exports = exportsOf<AtomicApi>(instance);
    const storeIndex = functionIndex(instrumented, 'atomic_store');
    const loadIndex = functionIndex(instrumented, 'atomic_load');
    const load16Index = functionIndex(instrumented, 'atomic_load16');

    exports.__wc_arm(1);

    exports.atomic_store(0x40, 0x11223344);
    // The callback fires after the store, under the storing function's index, and never as a read.
    expect(calls).toEqual([storeIndex]);
    expect(reads).toEqual([]);

    // The store went to the address it was given, so a store probe reporting no address costs
    // nothing: the value is where a load of 0x40 finds it.
    expect(exports.atomic_load(0x40)).toBe(0x11223344);
    expect(reads).toEqual([{ addr: 0x40, func: loadIndex }]);

    // The memarg offset is part of the reported address: 0x10 + 8 is where the store put 0x0c0d.
    reads.length = 0;
    exports.atomic_store(0x18, 0x0a0b0c0d);
    expect(exports.atomic_load16(0x10)).toBe(0x0c0d);
    expect(reads).toEqual([{ addr: 0x18, func: load16Index }]);
  });

  it('instruments vector loads and stores and leaves the vector math alone', () => {
    const plain = exportsOf<SimdApi>(new WebAssembly.Instance(new WebAssembly.Module(buildSimdModule())));
    const instrumented = instrumentModule(buildSimdModule());
    // `copy_v128` holds one load and one store, `add_vec` two loads.
    expect(instrumented.readCount).toBe(3);
    expect(instrumented.storeCount).toBe(1);
    expect(instrumented.probeCount).toBe(3);
    expect(instrumented.unprobed).toEqual([]);

    const { instance, calls, reads } = instantiateModule(instrumented);
    const exports = exportsOf<ArmedSimdApi>(instance);
    const copyIndex = functionIndex(instrumented, 'copy_v128');
    const addVecIndex = functionIndex(instrumented, 'add_vec');

    // Unarmed, the instrumented module answers what the plain one answers.
    expect(plain.add_vec(0)).toBe(11);
    expect(exports.add_vec(0)).toBe(11);
    expect(reads).toEqual([]);

    // Armed, each probe reports its own effective address and the answer is unchanged: the vector
    // math between the loads ran untouched, and `i32x4.add`'s two-byte subopcode was walked rather
    // than mistaken for two instructions.
    exports.__wc_arm(1);
    expect(exports.add_vec(0)).toBe(11);
    expect(reads).toEqual([
      { addr: 0x00, func: addVecIndex },
      { addr: 0x10, func: addVecIndex },
    ]);
    reads.length = 0;

    // The v128 store fired its callback and landed at 0x40: the sixteen bytes are the ones the
    // load read, and `add_vec(0x40)` answers lane 0 of what was stored (1) plus zero.
    exports.copy_v128(0x00, 0x40);
    expect(calls).toEqual([copyIndex]);
    expect(reads).toEqual([{ addr: 0x00, func: copyIndex }]);
    expect(new Uint8Array(exports.memory.buffer).slice(0x40, 0x50)).toEqual(
      new Uint8Array(plain.memory.buffer).slice(0x00, 0x10),
    );
    expect(exports.add_vec(0x40)).toBe(1);
  });

  it('walks a vector lane load without pretending it was probed', () => {
    const instrumented = instrumentModule(buildSimdLaneModule());
    // The lane load reads memory but cannot be probed: its address sits under the vector operand,
    // so it is reported instead of counted.
    expect(instrumented.unprobed).toEqual([
      { opcode: 0x54, functionIndex: 0, reason: expect.stringContaining('probe is not possible') },
    ]);
    expect(instrumented.readCount).toBe(0);
    expect(instrumented.probeCount).toBe(0);
    expect(instrumented.storeCount).toBe(1);

    const { instance, calls } = instantiateModule(instrumented);
    const exports = exportsOf<SimdLaneApi>(instance);
    exports.__wc_arm(1);
    exports.copy_lane(0x00, 0x40);

    // The walk stayed in step with the lane immediates: the module validates and copies the byte.
    expect(calls).toEqual([functionIndex(instrumented, 'copy_lane')]);
    const memory = new Uint8Array(exports.memory.buffer);
    expect(memory[0x40]).toBe(0x2a);
    expect(memory.slice(0x41, 0x50)).toEqual(new Uint8Array(15));

    // With reads off nobody asked for probes, so there is no gap to report.
    expect(instrumentModule(buildSimdLaneModule(), { reads: false }).unprobed).toEqual([]);
  });

  it('rejects a 0xFD subopcode the spec does not assign instead of guessing its immediates', () => {
    // 0x9A is a hole in the vector opcode space: its immediates are unknown, and emitting the bytes
    // with the wrong length would corrupt every instruction after it.
    const error = captureRejection(() => instrumentModule(buildOpcodeModule([0xfd, 0x9a, 0x01])));

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('0xFD subopcode 0x9a');
    expect(error.message).toContain('function 0');
  });

  it('rejects an atomic opcode that is neither a load nor a store', () => {
    // i32.atomic.rmw.add: a memarg form this rewriter does not instrument, so the module is refused
    // instead of instrumented around an access it never accounted for.
    const error = captureRejection(() =>
      instrumentModule(buildOpcodeModule([0x41, 0x00, 0x41, 0x01, 0xfe, 0x1e, 0x02, 0x00, 0x1a])),
    );

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('0xFE subopcode 0x1e');
    expect(error.message).toContain('function 0');
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

  it('stubs an exported function by name and leaves the rest of the module working', () => {
    const instrumented = instrumentModule(buildPatchModule(), {
      patches: [{ byName: 'score', mode: 'stub', value: 999 }],
    });
    const exports = exportsOf<PatchExports>(instantiateModule(instrumented).instance);

    expect(exports.score()).toBe(999);
    // `score` is defined function 2: helper, add, score. Indices of the input module's functions,
    // not of the instrumented one, which the callback imports shift.
    expect(instrumented.patchedFunctions).toEqual([2]);
    expect(instrumented.functionCount).toBe(6);

    // The neighbours keep their bodies and, with them, their behaviour.
    expect(exports.add(2, 3)).toBe(5);
    expect(exports.flag()).toBe(1.5);
  });

  it('stubs a private function by index, which shows up through the export that calls it', () => {
    const plain = exportsOf<PatchExports>(instantiateModule(instrumentModule(buildPatchModule())).instance);
    expect(plain.add(2, 3)).toBe(5);

    // `helper` is defined function 0 and has no export, so an index is the only way to reach it.
    const instrumented = instrumentModule(buildPatchModule(), {
      patches: [{ function: 0, mode: 'stub', value: 999 }],
    });
    const exports = exportsOf<PatchExports>(instantiateModule(instrumented).instance);

    expect(instrumented.patchedFunctions).toEqual([0]);
    // `add` computes a + b + helper() - 10, so the stubbed constant arrives through an export that
    // was not patched itself.
    expect(exports.add(2, 3)).toBe(2 + 3 + 999 - 10);
  });

  it('accepts an empty body only where the function returns nothing', () => {
    const instrumented = instrumentModule(buildPatchModule(), {
      patches: [{ byName: 'noop', mode: 'empty' }],
    });
    const exports = exportsOf<PatchExports>(instantiateModule(instrumented).instance);

    expect(instrumented.patchedFunctions).toEqual([4]);
    expect(exports.noop()).toBeUndefined();

    const error = captureRejection(() =>
      instrumentModule(buildPatchModule(), { patches: [{ byName: 'score', mode: 'empty' }] }),
    );
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toMatch(/UNSUPPORTED|unsupported|no results|result/);
    expect(error.message).toContain('score');
  });

  it('rejects a patch naming an export the module does not have', () => {
    const error = captureRejection(() =>
      instrumentModule(buildPatchModule(), { patches: [{ byName: 'missing_function', mode: 'stub' }] }),
    );

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('missing_function');
  });

  it('leaves a stubbed body out of the read instrumentation', () => {
    const unpatched = instrumentModule(buildPatchModule(), { reads: true, writes: false });
    // `helper` and `score` hold one load each.
    expect(unpatched.readCount).toBe(2);
    expect(unpatched.probeCount).toBe(2);

    const instrumented = instrumentModule(buildPatchModule(), {
      reads: true,
      writes: false,
      patches: [{ byName: 'score', mode: 'stub', value: 999 }],
    });
    expect(instrumented.readCount).toBe(1);
    expect(instrumented.probeCount).toBe(1);

    const { instance, reads } = instantiateModule(instrumented);
    const exports = exportsOf<PatchExports>(instance);
    exports.__wc_arm(1);

    // The stubbed export cannot hit a probe because its load left with the body it replaced.
    expect(exports.score()).toBe(999);
    expect(reads).toEqual([]);

    // The probe that survived still reports, under the private helper's own index — one slot below
    // its only caller `add`.
    expect(exports.add(2, 3)).toBe(5);
    expect(reads).toEqual([{ addr: 0x04, func: functionIndex(instrumented, 'add') - 1 }]);
  });

  it('encodes float and i64 stubs at their own width and sign', () => {
    const plain = exportsOf<PatchExports>(
      instantiateModule(instrumentModule(buildPatchModule(), { reads: false, writes: false })).instance,
    );
    expect(plain.flag()).toBe(1.5);
    expect(plain.big()).toBe(7n);

    const instrumented = instrumentModule(buildPatchModule(), {
      reads: false,
      writes: false,
      patches: [
        { byName: 'flag', mode: 'stub', value: 2.5 },
        { byName: 'big', mode: 'stub', value: -9000000000n },
      ],
    });
    const exports = exportsOf<PatchExports>(instantiateModule(instrumented).instance);

    // A wrong width stops the module validating; a wrong LEB128 sign returns another number.
    expect(exports.flag()).toBe(2.5);
    expect(exports.big()).toBe(-9000000000n);
    expect(instrumented.patchedFunctions).toEqual([3, 5]);
  });

  it('puts the flag after imported globals instead of on top of one', () => {
    // store_at(addr, value) over an imported memory, next to an imported mutable i32 global.
    const instrumented = instrumentModule(
      buildRawModule([
        [1, [0x01, 0x60, 0x02, 0x7f, 0x7f, 0x00]],
        [2, [0x02, ...ascii('env'), ...ascii('g'), 0x03, 0x7f, 0x01, ...ascii('env'), ...ascii('mem'), 0x02, 0x00, 0x01]],
        [3, [0x01, 0x00]],
        [7, [0x01, ...ascii('store_at'), 0x00, 0x00]],
        [10, [0x01, ...codeBody([0x00], [0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00])]],
      ]),
      { reads: false },
    );
    const g = new WebAssembly.Global({ value: 'i32', mutable: true }, 1234);
    const calls: number[] = [];
    const instance = new WebAssembly.Instance(new WebAssembly.Module(instrumented.bytes), {
      env: { g, mem: new WebAssembly.Memory({ initial: 1 }) },
      __wasmcheat: { on_store: (func: number) => calls.push(func) },
    });
    const exports = exportsOf<{ store_at(addr: number, value: number): void; __wc_arm(flags: number): void }>(
      instance,
    );

    exports.store_at(0, 7);
    expect(calls).toEqual([]);
    exports.__wc_arm(1);
    exports.store_at(0, 7);
    expect(g.value).toBe(1234);
    expect(calls).toHaveLength(1);
  });

  it('refuses a typed reference local instead of reading its heap type as an opcode', () => {
    // One local of `(ref null 0)`: 0x63 then the heap type, which a one-byte read would leave behind.
    const error = captureRejection(() =>
      instrumentModule(
        buildRawModule([
          [1, [0x01, 0x60, 0x00, 0x00]],
          [3, [0x01, 0x00]],
          [10, [0x01, ...codeBody([0x01, 0x01, 0x63, 0x00], [])]],
        ]),
      ),
    );

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('typed reference');
  });

  it('decodes a memarg that names memory 0 explicitly', () => {
    // i32.load with alignment 0x42 (bit 6: a memory index follows), memory 0, offset 4.
    const instrumented = instrumentModule(
      buildRawModule([
        [1, [0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f]],
        [3, [0x01, 0x00]],
        [5, [0x01, 0x00, 0x01]],
        [7, [0x01, ...ascii('f'), 0x00, 0x00]],
        [10, [0x01, ...codeBody([0x00], [0x20, 0x00, 0x28, 0x42, 0x00, 0x04])]],
      ]),
    );
    const { instance, reads } = instantiateModule(instrumented);
    const exports = exportsOf<{ f(addr: number): number; __wc_arm(flags: number): void }>(instance);

    exports.__wc_arm(1);
    expect(exports.f(8)).toBe(0);
    expect(instrumented.readCount).toBe(1);
    expect(reads).toEqual([{ addr: 12, func: functionIndex(instrumented, 'f') }]);
  });

  it('refuses to instrument a module twice', () => {
    const error = captureRejection(() => instrumentModule(instrumentModule(buildStoreModule()).bytes));

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('already instrumented');
  });

  it('keeps the name section pointing at the function it names', () => {
    // run() traps; the name section calls function 0 "victim", and the engine's stack trace uses it.
    const instrumented = instrumentModule(
      buildRawModule([
        [1, [0x01, 0x60, 0x00, 0x00]],
        [3, [0x01, 0x00]],
        [7, [0x01, ...ascii('run'), 0x00, 0x00]],
        [10, [0x01, ...codeBody([0x00], [0x00])]],
        [0, [...ascii('name'), 0x01, 0x09, 0x01, 0x00, ...ascii('victim')]],
      ]),
    );
    const exports = exportsOf<{ run(): void }>(instantiateModule(instrumented).instance);

    let stack = '';
    try {
      exports.run();
    } catch (error) {
      stack = String((error as Error).stack);
    }
    expect(stack).toContain('victim');
  });

  it('names a table in the refusal of a 64-bit table import', () => {
    const error = captureRejection(() =>
      instrumentModule(
        buildRawModule([
          [1, [0x00]],
          [2, [0x01, ...ascii('env'), ...ascii('t'), 0x01, 0x70, 0x04, 0x01]],
        ]),
      ),
    );

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('64-bit table');
  });

  it('refuses an i64 stub value that is not a finite number', () => {
    const error = captureRejection(() =>
      instrumentModule(buildPatchModule(), { patches: [{ byName: 'big', mode: 'stub', value: Number.NaN }] }),
    );

    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('NaN');
  });
});
