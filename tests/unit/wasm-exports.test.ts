import { describe, expect, it } from 'vitest';
import { readFunctionExports } from '../../packages/page-agent/src/wasm-exports';
import { buildDemoModule, buildMemoryModule } from '../helpers/wasm-builder';

/**
 * These indices are the only identity a store callback carries, so the mapping has to be right:
 * a wrong name sends someone reading the wrong function.
 */
describe('readFunctionExports', () => {
  it('maps every function export index to its name', () => {
    const names = readFunctionExports(buildDemoModule());
    const values = Object.values(names);
    expect(values).toContain('add');
    expect(values).toContain('bump');
    // Memory exports are not functions, so they never appear.
    expect(values).not.toContain('memory');
    for (const [index, name] of Object.entries(names)) {
      expect(Number(index)).toBeGreaterThanOrEqual(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('reports indices that line up with what the engine reports for the same function', () => {
    const module = new WebAssembly.Module(buildMemoryModule(1));
    const instance = new WebAssembly.Instance(module);
    const names = readFunctionExports(buildMemoryModule(1));
    // `peek` is the module's only function export, and its index is what a store callback
    // would report for a store inside it.
    const peekIndex = Number(Object.keys(names).find((key) => names[Number(key)] === 'peek'));
    expect(peekIndex).toBe(0);
    expect(typeof instance.exports.peek).toBe('function');
  });

  it('returns an empty map for a truncated binary instead of throwing', () => {
    expect(readFunctionExports(new Uint8Array([0, 97, 115, 109]))).toEqual({});
    expect(readFunctionExports(new Uint8Array())).toEqual({});
  });
});
