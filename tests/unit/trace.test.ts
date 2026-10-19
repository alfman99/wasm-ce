import { describe, expect, it } from 'vitest';
import { WasmRegistry } from '../../packages/page-agent/src/registry';
import { TraceStore, type BinaryRewriter } from '../../packages/page-agent/src/trace';
import { buildLoadModule, buildStoreModule } from '../helpers/wasm-builder';
import { instrumentModule } from '../../packages/wasm-instrument/src/index';

const rewriter: BinaryRewriter = (bytes, modes) => {
  const result = instrumentModule(bytes, modes);
  return {
    bytes: result.bytes,
    importModule: result.importModule,
    importField: result.importField,
    readField: 'on_read',
    armExport: result.armExport,
  };
};

/**
 * The runtime composes one instrumenter from the watchpoint and the patch store, because both
 * share a single rewrite pass. Tests wire the same thing for a trace-only setup.
 */
function makeTrace(registry: WasmRegistry): TraceStore {
  const trace: TraceStore = new TraceStore(registry, rewriter, () => {
    const modes = trace.modes();
    if (!modes) {
      registry.setInstrumenter(null);
      return;
    }
    registry.setInstrumenter({
      modes,
      rewrite: (bytes, requested) => rewriter(bytes, requested),
      onStore: (funcIndex) => trace.handleStore(funcIndex),
      onRead: (address, funcIndex) => trace.handleRead(address, funcIndex),
    });
  });
  return trace;
}

describe('TraceStore', () => {
  it('arms the registry instrumenter and disarms it again on stop', () => {
    const registry = new WasmRegistry();
    registry.install();
    const trace = makeTrace(registry);
    expect(registry.hasInstrumenter).toBe(false);

    trace.arm({ address: 'w1:0x100', type: 'i32' });
    expect(registry.hasInstrumenter).toBe(true);
    expect(trace.status().armed).toBe(true);

    trace.stop();
    expect(registry.hasInstrumenter).toBe(false);
    expect(trace.status().installed).toBe(false);
  });

  it('says plainly that an already running page cannot report writes', async () => {
    const registry = new WasmRegistry();
    registry.install();
    await WebAssembly.instantiate(buildStoreModule(), { env: {} });
    expect(registry.list()).toHaveLength(1);

    const trace = makeTrace(registry);
    const status = trace.arm({ address: 'w1:0x100', type: 'i32' });
    expect(status.installed).toBe(false);
    expect(status.note).toMatch(/reload/);
  });

  it('records a hit with the function that performed the store', async () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = makeTrace(registry);
    trace.arm({ address: 'w1:0x100', type: 'i32' });

    const bytes = buildStoreModule();
    const { instance } = await WebAssembly.instantiate(bytes, { env: {} });
    expect(registry.list()[0]?.instrumented).toBe(true);

    const exports = instance.exports as unknown as { store_at: (addr: number, value: number) => void };
    exports.store_at(0x100, 4242);

    const hits = trace.status().hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.funcName).toBe('store_at');
    expect(hits[0]?.value).toBe(4242);
  });

  it('records a read with the function that loaded the address, and nothing when disarmed', async () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = makeTrace(registry);
    const armed = trace.arm({ address: 'w1:0x20', type: 'i32', kind: 'read' });
    expect(armed.kind).toBe('read');
    expect(registry.hasInstrumenter).toBe(true);

    const { instance } = await WebAssembly.instantiate(buildLoadModule(), { env: {} });
    expect(registry.list()[0]?.instrumented).toBe(true);
    const exports = instance.exports as unknown as { read_at: (addr: number) => number };

    // Reads of other addresses are not recorded, reads of the watched one are.
    expect(exports.read_at(0x24)).toBe(0x44332211);
    expect(trace.status().hits).toHaveLength(0);
    expect(exports.read_at(0x20)).toBe(-0x21524111); // 0xdeadbeef as a signed i32

    const hits = trace.status().hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('read');
    expect(hits[0]?.funcName).toBe('read_at');
    expect(trace.status().functions[0]).toMatchObject({ name: 'read_at', hits: 1 });

    // A disarmed trace leaves the instrumented module alone but records nothing further.
    trace.stop();
    expect(exports.read_at(0x20)).toBe(-0x21524111);
    expect(trace.status().hits).toHaveLength(1);
    expect(trace.status().armed).toBe(false);
  });
});
