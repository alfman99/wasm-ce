import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAccess } from '../../packages/page-agent/src/memory';
import { ScanStore } from '../../packages/page-agent/src/scanner';

const INSTANCE = 'w1';

function setup(): { access: MemoryAccess; scans: ScanStore; memory: WebAssembly.Memory } {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const access = new MemoryAccess(memory);
  return { access, scans: new ScanStore(), memory };
}

describe('ScanStore', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('finds exact i32 matches and reports them as addresses', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'i32', 1234);
    access.write(0x400, 'i32', 1234);
    access.write(0x800, 'i32', 99);

    const summary = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'exact', value: 1234 });
    expect(summary.matchCount).toBe(2);
    expect(summary.memoryByteLength).toBe(131072);
    expect(summary.sample.map((hit) => hit.address.offset).sort((a, b) => a - b)).toEqual([0x100, 0x400]);
    expect(summary.scanId).toMatch(/^s\d+$/);
  });

  it('narrows a changed pass down to the addresses that actually moved', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'i32', 10);
    access.write(0x200, 'i32', 10);
    access.write(0x300, 'i32', 10);

    const first = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'changed' });
    expect(first.matchCount).toBeGreaterThan(2);

    access.write(0x100, 'i32', 11);
    access.write(0x200, 'i32', 12);
    access.write(0x300, 'i32', 9);

    const changed = scans.narrow(access, first.scanId, 'changed', {});
    expect(changed.matchCount).toBe(3);
    const sample = scans.results(first.scanId, access, 0, 10);
    expect(sample.total).toBe(3);
    expect(sample.hits.map((hit) => hit.value).sort((a, b) => a - b)).toEqual([9, 11, 12]);
  });

  it('narrows increased and decreased passes', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'i32', 10);
    access.write(0x200, 'i32', 10);
    access.write(0x300, 'i32', 10);

    const before = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'unchanged' });
    access.write(0x100, 'i32', 11);
    access.write(0x200, 'i32', 12);
    access.write(0x300, 'i32', 9);

    const increased = scans.narrow(access, before.scanId, 'increased', {});
    expect(increased.matchCount).toBe(2);
    expect(scans.results(before.scanId, access, 0, 10).hits.map((hit) => hit.address.offset).sort((a, b) => a - b)).toEqual([
      0x100, 0x200,
    ]);

    const second = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'unchanged' });
    access.write(0x100, 'i32', 1);
    const decreased = scans.narrow(access, second.scanId, 'decreased', {});
    expect(decreased.matchCount).toBe(1);
    expect(scans.results(second.scanId, access, 0, 10).hits[0]!.value).toBe(1);
  });

  it('filters a narrowing pass by an exact value when one is given', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'i32', 5);
    access.write(0x200, 'i32', 5);
    const first = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'changed' });
    access.write(0x100, 'i32', 42);
    access.write(0x200, 'i32', 7);
    const narrowed = scans.narrow(access, first.scanId, 'changed', { value: 42 });
    expect(narrowed.matchCount).toBe(1);
    expect(scans.results(first.scanId, access, 0, 5).hits[0]!.address.offset).toBe(0x100);
  });

  it('only sees unaligned hits when alignment is 1', () => {
    const { access, scans } = ctx;
    access.write(0x101, 'i32', 777);
    const aligned = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'exact', value: 777 });
    expect(aligned.matchCount).toBe(0);
    const unaligned = scans.pass(access, {
      instanceId: INSTANCE,
      type: 'i32',
      mode: 'exact',
      value: 777,
      alignment: 1,
    });
    expect(unaligned.matchCount).toBe(1);
    expect(unaligned.sample[0]!.address.offset).toBe(0x101);
  });

  it('applies float tolerance instead of demanding bit equality', () => {
    const { access, scans } = ctx;
    access.write(0x40, 'f32', 1.5);
    const exact = scans.pass(access, { instanceId: INSTANCE, type: 'f32', mode: 'exact', value: 1.5000001 });
    expect(exact.matchCount).toBe(1);
    const strict = scans.pass(access, {
      instanceId: INSTANCE,
      type: 'f32',
      mode: 'exact',
      value: 1.5000001,
      tolerance: 0,
    });
    expect(strict.matchCount).toBe(0);
  });

  it('respects range and maxResults', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'i32', 5);
    access.write(0x9000, 'i32', 5);
    const ranged = scans.pass(access, {
      instanceId: INSTANCE,
      type: 'i32',
      mode: 'exact',
      value: 5,
      range: { start: 0, end: 0x1000 },
    });
    expect(ranged.matchCount).toBe(1);

    const capped = scans.pass(access, {
      instanceId: INSTANCE,
      type: 'i32',
      mode: 'exact',
      value: 0,
      maxResults: 3,
    });
    expect(capped.matchCount).toBe(3);
    expect(capped.truncated).toBe(true);
  });

  it('refuses exact scans without a value and closed sessions', () => {
    const { access, scans } = ctx;
    expect(() => scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'exact' })).toThrow(/requires a value/);
    expect(() => scans.narrow(access, 's999', 'changed', {})).toThrow(/no scan session/);
  });

  it('keeps scanning after memory grows', () => {
    const { access, scans, memory } = ctx;
    access.write(0x100, 'i32', 5);
    const first = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'exact', value: 5 });
    memory.grow(1);
    access.write(0x18000, 'i32', 5);
    const narrowed = scans.narrow(access, first.scanId, 'exact', { value: 5 });
    expect(narrowed.matchCount).toBe(1);
    expect(narrowed.memoryByteLength).toBe(196608);
  });

  it('drops sessions', () => {
    const { access, scans } = ctx;
    const first = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'changed' });
    expect(scans.drop(first.scanId)).toBe(true);
    expect(() => scans.results(first.scanId, access, 0, 1)).toThrow(/no scan session/);
  });
});
