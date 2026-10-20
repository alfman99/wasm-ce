import { describe, expect, it, vi } from 'vitest';
import { PatchStore } from '../../packages/page-agent/src/patch';
import { PageRuntime } from '../../packages/page-agent/src/runtime';
import { WasmRegistry } from '../../packages/page-agent/src/registry';
import { instrumentModule } from '../../packages/wasm-instrument/src/index';
import { buildPatchModule } from '../helpers/wasm-builder';

/**
 * Patches and watchpoints share one rewrite pass (a second pass would shift function indices
 * twice), so the store itself only records intent; the runtime builds the instrumenter.
 */
function wire(registry: WasmRegistry, patches: PatchStore): void {
  registry.setInstrumenter({
    modes: { reads: false, writes: false },
    rewrite: (bytes, modes) => {
      const result = instrumentModule(bytes, { ...modes, patches: patches.activePatches() });
      patches.markApplied(result.patchedFunctions);
      return {
        bytes: result.bytes,
        importModule: result.importModule,
        importField: result.importField,
        readField: 'on_read',
        armExport: result.armExport,
      };
    },
    onStore: () => undefined,
    onRead: () => undefined,
  });
}

describe('PatchStore', () => {
  it('records a patch by export name and hands the rewriter a byName request', () => {
    const patches = new PatchStore(() => undefined);
    const entry = patches.add({ target: 'score', mode: 'stub', value: 999 });
    expect(entry.id).toBe('p1');
    expect(entry.applied).toBe(false);
    expect(patches.list()).toHaveLength(1);
    expect(patches.activePatches()).toEqual([{ byName: 'score', mode: 'stub', value: 999 }]);
  });

  it('a patch restored after a reload installs the instrumenter without another add', () => {
    const stored: Record<string, string> = {
      'wasmcheat.patches': JSON.stringify([{ target: 'score', mode: 'stub', value: 999 }]),
    };
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => void (stored[key] = value),
      removeItem: (key: string) => void delete stored[key],
    });
    try {
      const runtime = new PageRuntime();
      expect(runtime.registry.hasInstrumenter).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a frame with no sessionStorage takes the patches the extension kept, once', () => {
    // A sandboxed iframe (YouTube Playables) throws on sessionStorage, so its own copy is gone.
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => undefined,
    });
    try {
      let wired = 0;
      const patches = new PatchStore(() => void wired++);
      expect(patches.list()).toEqual([]);
      const adopted = patches.adopt([{ target: 'wasm-function[10]', mode: 'empty', note: 'gravity' }]);
      expect(adopted.map((entry) => [entry.target, entry.mode, entry.note])).toEqual([['wasm-function[10]', 'empty', 'gravity']]);
      expect(wired).toBe(1);
      // A second delivery (another frame announcing, a re-sent copy) must not double the list.
      patches.adopt([{ target: 'wasm-function[10]', mode: 'empty' }]);
      expect(patches.list()).toHaveLength(1);
      expect(patches.adopt('not a list')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('understands the wasm-function[N] spelling that list_instances uses', () => {
    const patches = new PatchStore(() => undefined);
    patches.add({ target: 'wasm-function[12]', mode: 'stub' });
    expect(patches.activePatches()).toEqual([{ function: 12, mode: 'stub' }]);
  });

  it('rejects an unknown mode, an empty target and an unknown id', () => {
    const patches = new PatchStore(() => undefined);
    expect(() => patches.add({ target: 'score', mode: 'nuke' as never })).toThrow(/unknown patch mode/);
    expect(() => patches.add({ target: '   ', mode: 'stub' })).toThrow(/must be an export name/);
    expect(() => patches.remove('p99')).toThrow(/no patch with id/);
  });

  it('marks a patch applied with the function index the rewriter resolved', () => {
    const patches = new PatchStore(() => undefined);
    patches.add({ target: 'score', mode: 'stub', value: 999 });
    patches.markApplied([7]);
    const [entry] = patches.list();
    expect(entry?.applied).toBe(true);
    expect(entry?.funcIndex).toBe(7);
    expect(entry?.applications).toBe(1);
  });

  it('a stub installed through the instrumenter changes what the wasm returns', async () => {
    const registry = new WasmRegistry();
    const patches = new PatchStore(() => undefined);
    wire(registry, patches);
    registry.install();

    patches.add({ target: 'score', mode: 'stub', value: 999 });
    patches.add({ target: 'noop', mode: 'empty' });
    expect(patches.list().every((entry) => !entry.applied)).toBe(true);

    const { instance } = await WebAssembly.instantiate(buildPatchModule(), {
      env: {},
      __wasmcheat: { on_store: () => undefined, on_read: () => undefined },
    });
    const exports = instance.exports as unknown as {
      score: () => number;
      add: (a: number, b: number) => number;
      noop: () => void;
    };
    expect(exports.score()).toBe(999);
    expect(exports.add(2, 3)).toBe(5);
    expect(exports.noop()).toBeUndefined();

    const list = patches.list();
    expect(list.every((entry) => entry.applied)).toBe(true);
    expect(list.map((entry) => entry.funcIndex)).toEqual([2, 4]);
  });

  it('removing a patch and instantiating again brings the original body back', async () => {
    const registry = new WasmRegistry();
    const patches = new PatchStore(() => undefined);
    wire(registry, patches);
    registry.install();

    const entry = patches.add({ target: 'score', mode: 'stub', value: 999 });
    const first = await WebAssembly.instantiate(buildPatchModule(), {
      env: {},
      __wasmcheat: { on_store: () => undefined, on_read: () => undefined },
    });
    expect((first.instance.exports as unknown as { score: () => number }).score()).toBe(999);

    patches.remove(entry.id);
    const second = await WebAssembly.instantiate(buildPatchModule(), {
      env: {},
      __wasmcheat: { on_store: () => undefined, on_read: () => undefined },
    });
    expect((second.instance.exports as unknown as { score: () => number }).score()).toBe(25);
  });
});
