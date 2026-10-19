import { describe, expect, it } from 'vitest';
import { WasmRegistry } from '../../packages/page-agent/src/registry';
import { TraceStore, type BinaryRewriter } from '../../packages/page-agent/src/trace';
import { buildStoreModule } from '../helpers/wasm-builder';
import { instrumentModule } from '../../packages/wasm-instrument/src/index';

const rewriter: BinaryRewriter = (bytes) => {
  const result = instrumentModule(bytes);
  return {
    bytes: result.bytes,
    importModule: result.importModule,
    importField: result.importField,
    armExport: result.armExport,
  };
};

describe('TraceStore', () => {
  it('arms the registry instrumenter and disarms it again on stop', () => {
    const registry = new WasmRegistry();
    registry.install();
    const trace = new TraceStore(registry, rewriter);
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

    const trace = new TraceStore(registry, rewriter);
    const status = trace.arm({ address: 'w1:0x100', type: 'i32' });
    expect(status.installed).toBe(false);
    expect(status.note).toMatch(/reload/);
  });

  it('records a hit with the function that performed the store', async () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = new TraceStore(registry, rewriter);
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
});
