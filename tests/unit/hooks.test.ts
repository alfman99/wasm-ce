import { beforeEach, describe, expect, it } from 'vitest';
import { HookStore } from '../../packages/page-agent/src/hooks';
import { WasmRegistry } from '../../packages/page-agent/src/registry';
import { buildDemoModule } from '../helpers/wasm-builder';

type Add = (a: number, b: number) => number;
type ReadScore = () => number;

describe('HookStore export hooks', () => {
  let registry: WasmRegistry;
  let hooks: HookStore;
  let instance: WebAssembly.Instance;
  let instanceId: string;

  beforeEach(async () => {
    registry = new WasmRegistry();
    registry.install();
    hooks = new HookStore(registry, true);
    const typed = (await WebAssembly.instantiate(buildDemoModule(), { env: { log: () => undefined } })) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    instance = typed.instance;
    instanceId = registry.list().at(-1)!.id;
  });

  it('wraps an export and passes the original result through ctx.call', () => {
    const entry = hooks.add({ instanceId, target: 'export', name: 'add', body: 'return ctx.call(args) * 2;' });
    expect((instance.exports.add as Add)(2, 3)).toBe(10);
    expect(entry.calls).toBe(0);
    const listed = hooks.list().find((hook) => hook.id === entry.id)!;
    expect(listed.calls).toBe(1);
    expect(listed.lastArgs).toEqual([2, 3]);
    expect(listed.pending).toBe(false);
  });

  it('replaces an export outright when the body never calls the original', () => {
    hooks.add({ instanceId, target: 'export', name: 'read_score', body: 'return 9999;' });
    expect((instance.exports.read_score as ReadScore)()).toBe(9999);
  });

  it('passes the original value through when the body only observes', () => {
    hooks.add({ instanceId, target: 'export', name: 'add', body: 'const seen = args[0] + args[1];' });
    expect((instance.exports.add as Add)(2, 5)).toBe(7);
  });

  it('can rewrite arguments before calling the original', () => {
    hooks.add({ instanceId, target: 'export', name: 'add', body: 'return ctx.call([args[0] * 10, args[1]]);' });
    expect((instance.exports.add as Add)(2, 3)).toBe(23);
  });

  it('honours enable/disable without removing the hook', () => {
    const entry = hooks.add({ instanceId, target: 'export', name: 'add', body: 'return 1;' });
    expect((instance.exports.add as Add)(1, 1)).toBe(1);
    hooks.setEnabled(entry.id, false);
    expect((instance.exports.add as Add)(1, 1)).toBe(2);
    hooks.setEnabled(entry.id, true);
    expect((instance.exports.add as Add)(1, 1)).toBe(1);
  });

  it('restores the original export on remove', () => {
    const original = instance.exports.add;
    const entry = hooks.add({ instanceId, target: 'export', name: 'add', body: 'return 0;' });
    expect(instance.exports.add).not.toBe(original);
    expect(hooks.remove(entry.id)).toBe(true);
    expect(instance.exports.add).toBe(original);
    expect((instance.exports.add as Add)(4, 4)).toBe(8);
  });

  it('stacks two hooks and unwinds them in order', () => {
    const first = hooks.add({ instanceId, target: 'export', name: 'add', body: 'return ctx.call(args) + 1;' });
    const second = hooks.add({ instanceId, target: 'export', name: 'add', body: 'return ctx.call(args) * 10;' });
    expect((instance.exports.add as Add)(1, 1)).toBe(30);
    hooks.remove(second.id);
    expect((instance.exports.add as Add)(1, 1)).toBe(3);
    hooks.remove(first.id);
    expect((instance.exports.add as Add)(1, 1)).toBe(2);
  });

  it('rejects unknown exports and compiles nothing invalid', () => {
    expect(() => hooks.add({ instanceId, target: 'export', name: 'nope', body: 'return 1;' })).toThrow(/no function export/);
    expect(() => hooks.add({ instanceId, target: 'export', name: 'add', body: 'return (' })).toThrow(/failed to compile/);
  });

  it('falls back to declarative behaviour when the page forbids eval', async () => {
    const strict = new HookStore(registry, false);
    strict.add({
      instanceId,
      target: 'export',
      name: 'read_score',
      body: 'return 1;',
      fallback: { mode: 'replace-return', value: 42 },
    });
    expect((instance.exports.read_score as ReadScore)()).toBe(42);
    const entry = strict.list()[0]!;
    expect(entry.fallbackUsed).toBe(true);
    expect(strict.add({
      instanceId,
      target: 'export',
      name: 'add',
      body: 'return 0;',
      fallback: { mode: 'offset-result', value: 1 },
    }).id).toBeDefined();
    expect((instance.exports.add as Add)(2, 2)).toBe(5);
  });
});

describe('HookStore import hooks', () => {
  it('marks an import hook pending on a live instance and applies it to the next instantiation', async () => {
    const registry = new WasmRegistry();
    registry.install();
    const hooks = new HookStore(registry, true);
    const typed = (await WebAssembly.instantiate(buildDemoModule(), { env: { log: () => undefined } })) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const instanceId = registry.list().at(-1)!.id;

    const entry = hooks.add({
      instanceId,
      target: 'import',
      name: 'env.log',
      body: 'return ctx.call([args[0] * 3]);',
    });
    expect(entry.pending).toBe(true);

    const seen: unknown[][] = [];
    const fresh = (await WebAssembly.instantiate(buildDemoModule(), {
      env: { log: (...args: unknown[]) => seen.push(args) },
    })) as WebAssembly.WebAssemblyInstantiatedSource;
    (fresh.instance.exports.shout as () => void)();
    expect(seen).toEqual([[21]]);

    // The instance that was already running keeps its captured funcref.
    expect(() => (typed.instance.exports.shout as () => void)()).not.toThrow();
  });

  it('requires module.name form for imports', () => {
    const registry = new WasmRegistry();
    const hooks = new HookStore(registry, true);
    registry.install();
    const id = registry.adopt(new WebAssembly.Instance(new WebAssembly.Module(buildDemoModule()), {
      env: { log: () => undefined },
    })).id;
    expect(() => hooks.add({ instanceId: id, target: 'import', name: 'log', body: '' })).toThrow(/must look like/);
  });
});
