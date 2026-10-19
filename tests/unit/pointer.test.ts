import { describe, expect, it } from 'vitest';
import { MemoryAccess } from '../../packages/page-agent/src/memory';
import { pointerResolve, pointerScan } from '../../packages/page-agent/src/pointer';
import { buildMemoryModule } from '../helpers/wasm-builder';

/**
 * Three-level chain: 0x100 -> 0x200, 0x200 -> 0x300, 0x300 holds the value we want at 0x310.
 * Written by hand so the expected paths are exact.
 */
function chainAccess(): { access: MemoryAccess; instance: WebAssembly.Instance } {
  const { instance } = (() => {
    const built = new WebAssembly.Instance(new WebAssembly.Module(buildMemoryModule(2)), {});
    return { instance: built };
  })();
  const memory = instance.exports.memory as WebAssembly.Memory;
  const access = new MemoryAccess(memory);
  access.write(0x100, 'u32', 0x200);
  access.write(0x200, 'u32', 0x300);
  access.write(0x300, 'u32', 0xdead);
  access.write(0x310, 'i32', 4242);
  return { access, instance };
}

describe('pointerScan', () => {
  it('follows a chain backwards from the target and reports offsets in application order', () => {
    const { access } = chainAccess();
    const paths = pointerScan(access, { instanceId: 'w1', offset: 0x310, maxDepth: 3, maxOffset: 0x40 });

    expect(paths.length).toBeGreaterThan(0);
    const shortest = paths[0]!;
    expect(shortest.depth).toBe(1);
    // A direct pointer to 0x310 exists (the word at 0x300), so depth 1 comes first.
    expect(shortest.baseValue + shortest.offsets[0]!).toBe(0x310);

    const deep = paths.find((path) => path.base.offset === 0x100);
    expect(deep, `no chain from 0x100: ${JSON.stringify(paths.map((p) => [p.base.offset, p.offsets]))}`).toBeTruthy();
    expect(deep!.offsets).toEqual([0, 0x10]);
    expect(pointerResolve(access, 'w1', 0x100, deep!.offsets).value).toBe(4242);
  });

  it('returns nothing when the depth or the offset window is too small', () => {
    const { access } = chainAccess();
    // The only word holding 0x300 is at 0x200, which is further than 0x40 from 0x310.
    const paths = pointerScan(access, { instanceId: 'w1', offset: 0x310, maxDepth: 1, maxOffset: 0x10 });
    expect(paths.map((path) => path.base.offset)).not.toContain(0x100);
    expect(pointerScan(access, { instanceId: 'w1', offset: 0x310, maxDepth: 1, maxOffset: 0x40 })).toHaveLength(1);
  });

  it('refuses an address outside memory', () => {
    const { access } = chainAccess();
    expect(() => pointerScan(access, { instanceId: 'w1', offset: 0x40000 })).toThrow(/outside memory/);
  });

  it('reports a broken chain instead of pretending it resolved', () => {
    const { access } = chainAccess();
    // Two pages of memory: a base that points at the last word plus any offset leaves it.
    access.write(0x100, 'u32', 0x1fff0);
    const broken = pointerResolve(access, 'w1', 0x100, [0x10]);
    expect(broken.value).toBeNull();
    expect(broken.final).toBe('w1:0x20000');
    expect(broken.hops[0]).toEqual({ address: 'w1:0x100', value: 0x1fff0 });
  });
});
