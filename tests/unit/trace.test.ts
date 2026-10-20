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
      onStore: (funcIndex, instance) => trace.handleStore(funcIndex, instance),
      onRead: (address, funcIndex, instance) => trace.handleRead(address, funcIndex, instance),
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

  it('announces every recorded hit to the listener, and not the ones dropped at maxHits', async () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = makeTrace(registry);
    const announced: number[] = [];
    trace.onHit((hit) => announced.push(hit.value as number));
    trace.arm({ address: 'w1:0x100', type: 'i32', maxHits: 1 });

    const { instance } = await WebAssembly.instantiate(buildStoreModule(), { env: {} });
    const exports = instance.exports as unknown as { store_at: (addr: number, value: number) => void };
    exports.store_at(0x100, 11);
    exports.store_at(0x100, 22);

    // The second store happened and is counted, but the hit list was full, so it is not announced.
    expect(announced).toEqual([11]);
    expect(trace.status().dropped).toBe(1);
    expect(trace.status().functions[0]?.hits).toBe(2);
  });

  it('watches two armed instances in their own memory, named with their own functions', async () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = makeTrace(registry);
    trace.arm({ address: 'w1:0x30', type: 'i32' });

    // The game first, then a smaller helper: the last instrumented instance must not take over.
    const game = (await WebAssembly.instantiate(buildStoreModule(), { env: {} })).instance;
    const helper = (await WebAssembly.instantiate(buildLoadModule(), { env: {} })).instance;
    const [gameId, helperId] = registry.list().map((tracked) => tracked.id);

    (game.exports as unknown as { store_at: (addr: number, value: number) => void }).store_at(0x30, 4242);
    (helper.exports as unknown as { bump: () => number }).bump();

    const status = trace.status();
    expect(status.hits.map(({ address, funcName, previous, value }) => ({ address, funcName, previous, value }))).toEqual([
      { address: `${gameId}:0x30`, funcName: 'store_at', previous: 0, value: 4242 },
      { address: `${helperId}:0x30`, funcName: 'bump', previous: 0, value: 7 },
    ]);
    expect(status.instanceId).toBe(gameId);
    expect(status.functions.map(({ instanceId, name }) => `${instanceId}:${name}`).sort()).toEqual(
      [`${gameId}:store_at`, `${helperId}:bump`].sort(),
    );
  });

  it('instruments the synchronous new Module + new Instance path (wasm-bindgen initSync)', () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = makeTrace(registry);
    trace.arm({ address: 'w1:0x100', type: 'i32' });

    const module = new WebAssembly.Module(buildStoreModule());
    const instance = new WebAssembly.Instance(module, { env: {} });
    expect(module instanceof WebAssembly.Module).toBe(true);
    expect(WebAssembly.Module.exports(module).map((entry) => entry.name)).toContain('store_at');

    const tracked = registry.list()[0]!;
    expect(tracked.instrumented).toBe(true);
    expect(registry.describe(tracked).moduleHash).toMatch(/^[0-9a-f]{8}$/);

    (instance.exports as unknown as { store_at: (addr: number, value: number) => void }).store_at(0x100, 99);
    expect(trace.status().hits[0]).toMatchObject({ funcName: 'store_at', value: 99 });
  });

  it('hands back a bare Instance when an armed page instantiates a compiled Module', async () => {
    const registry = new WasmRegistry({
      onInstrumented: (tracked) => trace.onInstrumented(tracked),
    });
    registry.install();
    const trace = makeTrace(registry);
    trace.arm({ address: 'w1:0x100', type: 'i32' });

    const module = await WebAssembly.compile(buildStoreModule());
    const instance = (await WebAssembly.instantiate(module, { env: {} })) as unknown as WebAssembly.Instance;
    expect(instance instanceof WebAssembly.Instance).toBe(true);
    expect(registry.list()[0]?.instrumented).toBe(true);
    (instance.exports as unknown as { store_at: (addr: number, value: number) => void }).store_at(0x100, 5);
    expect(trace.status().hits[0]).toMatchObject({ funcName: 'store_at', value: 5 });
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
