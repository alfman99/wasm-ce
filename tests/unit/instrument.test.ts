import { describe, expect, it } from 'vitest';
import { BridgeError } from '@wasmcheat/protocol';
import { instrumentModule, type InstrumentedModule } from '../../packages/wasm-instrument/src/index';
import {
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
  /** Function indices pushed by the injected callback, in call order. */
  calls: number[];
}

function instantiateModule(instrumented: InstrumentedModule): Harness {
  const calls: number[] = [];
  const imports = {
    [instrumented.importModule]: {
      [instrumented.importField]: (functionIndex: number): void => {
        calls.push(functionIndex);
      },
    },
  };
  const module = new WebAssembly.Module(instrumented.bytes);
  return { instance: new WebAssembly.Instance(module, imports), calls };
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

    // `store_at` was function 0 before the callback import took slot 0 and pushed it to 1.
    expect(storeAtIndex).toBe(1);
    expect(tickIndex).toBe(3);

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

    // Only the element segment moved: `write_direct` was function 1 and is now 2, while the
    // indirect caller stayed at 1.
    expect(functionIndex(instrumented, 'write_via_table')).toBe(1);
    expect(writeDirectIndex).toBe(2);

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
});
