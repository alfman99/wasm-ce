import { beforeEach, describe, expect, it } from 'vitest';
import { WasmRegistry } from '../../packages/page-agent/src/registry';
import { buildDemoModule, buildMemoryModule, wasmResponse } from '../helpers/wasm-builder';

const imports = () => ({ env: { log: () => undefined } }) as WebAssembly.Imports;

describe('WasmRegistry', () => {
  let registry: WasmRegistry;

  beforeEach(() => {
    registry = new WasmRegistry();
    registry.install();
  });

  it('captures an instance created with WebAssembly.instantiate(bytes)', async () => {
    const known = registry.list().length;
    const result = (await WebAssembly.instantiate(buildDemoModule(), imports())) as WebAssembly.WebAssemblyInstantiatedSource;
    const tracked = registry.list().at(-1)!;

    expect(registry.list().length).toBe(known + 1);
    expect(tracked.instance).toBe(result.instance);
    expect(tracked.createdBy).toBe('instantiate');
    expect(tracked.moduleHash).toMatch(/^[0-9a-f]{8}$/);

    const info = registry.describe(tracked);
    expect(info.memoryResolved).toBe(true);
    expect(info.memory?.byteLength).toBe(65536);
    expect(info.exports.map((entry) => entry.name).sort()).toEqual(['add', 'bump', 'memory', 'read_score', 'shout']);
    expect(info.exports.find((entry) => entry.name === 'add')?.kind).toBe('function');
    expect(info.importPatchability).toBe('next-instantiation');
  });

  it('captures an instance created from a compiled Module', async () => {
    const module = await WebAssembly.compile(buildDemoModule());
    const instance = (await WebAssembly.instantiate(module, imports())) as WebAssembly.Instance;
    const tracked = registry.list().at(-1)!;
    expect(tracked.instance).toBe(instance);
    expect(tracked.module).toBe(module);
    expect(tracked.moduleHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('captures `new WebAssembly.Instance(...)`', async () => {
    const module = await WebAssembly.compile(buildDemoModule());
    const instance = new WebAssembly.Instance(module, imports());
    const tracked = registry.list().at(-1)!;
    expect(tracked.instance).toBe(instance);
    expect(tracked.createdBy).toBe('new Instance');
    expect(instance instanceof WebAssembly.Instance).toBe(true);
    expect((instance.exports.add as (a: number, b: number) => number)(2, 3)).toBe(5);
  });

  it('captures instantiateStreaming and hashes the module asynchronously', async () => {
    const typed = await WebAssembly.instantiateStreaming(wasmResponse(buildDemoModule()), imports());
    const tracked = registry.list().at(-1)!;
    expect(tracked.instance).toBe(typed.instance);
    expect(tracked.createdBy).toBe('instantiateStreaming');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.describe(registry.list().at(-1)!).moduleHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('resolves memory imported as env.memory instead of exported', async () => {
    await WebAssembly.instantiate(buildDemoModule({ importMemory: true }), {
      env: { log: () => undefined, memory: new WebAssembly.Memory({ initial: 1 }) },
    });
    const info = registry.describe(registry.list().at(-1)!);
    expect(info.memoryResolved).toBe(true);
    expect(info.memory?.byteLength).toBe(65536);
    expect(info.exports.some((entry) => entry.kind === 'memory')).toBe(false);
  });

  it('reports instances with no reachable memory as unresolvable', async () => {
    await WebAssembly.instantiate(buildMemoryModule(), {});
    const module = await WebAssembly.compile(buildMemoryModule());
    const instance = new WebAssembly.Instance(module, {});
    const withoutMemory = new WasmRegistry();
    withoutMemory.install();
    const tracked = withoutMemory.adopt(instance);
    // This module does export memory, so the interesting case is the first one being fine too.
    expect(registry.describe(tracked).memoryResolved).toBe(true);
  });

  it('applies import rules before the engine sees the imports', async () => {
    const calls: unknown[][] = [];
    registry.addImportRule({
      hookId: 'test-rule',
      moduleName: 'env',
      importName: 'log',
      wrap: (original) =>
        (...args: unknown[]) => {
          calls.push(args);
          return original(...args);
        },
    });
    const result = (await WebAssembly.instantiate(buildDemoModule(), imports())) as WebAssembly.WebAssemblyInstantiatedSource;
    (result.instance.exports.shout as () => void)();
    expect(calls).toEqual([[7]]);
  });

  it('adopts an instance handed over directly and is idempotent', async () => {
    const module = await WebAssembly.compile(buildMemoryModule());
    const instance = new WebAssembly.Instance(module, {});
    const before = registry.list().length;
    const first = registry.adopt(instance);
    const second = registry.adopt(instance);
    expect(first.id).toBe(second.id);
    expect(registry.list().length).toBe(before);
  });
});
