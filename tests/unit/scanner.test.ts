import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryAccess } from '../../packages/page-agent/src/memory';
import { ScanStore, scanText } from '../../packages/page-agent/src/scanner';

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

describe('ScanStore comparison operators', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  /** Fills the scanned range with a neutral value so only the seeded addresses differ. */
  function seed(access: MemoryAccess): void {
    for (let offset = 0x100; offset < 0x400; offset += 4) access.write(offset, 'i32', 60);
    access.write(0x100, 'i32', 10);
    access.write(0x200, 'i32', 50);
    access.write(0x300, 'i32', 90);
  }

  const RANGE = { start: 0x100, end: 0x400 };

  function offsets(summary: { sample: { address: { offset: number } }[] }): number[] {
    return summary.sample.map((hit) => hit.address.offset).sort((a, b) => a - b);
  }

  it('filters a first pass with less, greater, not-equal and the inclusive variants', () => {
    const { access, scans } = ctx;
    seed(access);

    // Whole-memory zeros match most comparisons, so every mode is checked on the seeded
    // addresses rather than on exact match lists.
    const hits = (summary: { scanId: string; matchCount: number }): Set<number> =>
      new Set(scans.results(summary.scanId, access, 0, summary.matchCount).hits.map((hit) => hit.address.offset));

    const greater = hits(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'greater', value: 50 }));
    expect(greater.has(0x300)).toBe(true);
    expect(greater.has(0x100)).toBe(false);
    expect(greater.has(0x200)).toBe(false);

    const less = hits(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'less', value: 50 }));
    expect(less.has(0x100)).toBe(true);
    expect(less.has(0x200)).toBe(false);

    const gte = hits(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'greater-or-equal', value: 50 }));
    expect([gte.has(0x200), gte.has(0x300), gte.has(0x100)]).toEqual([true, true, false]);

    const lte = hits(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'less-or-equal', value: 50 }));
    expect([lte.has(0x100), lte.has(0x200), lte.has(0x300)]).toEqual([true, true, false]);

    const other = hits(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'not-equal', value: 50 }));
    expect([other.has(0x100), other.has(0x200), other.has(0x300)]).toEqual([true, false, true]);
  });

  it('supports a between range in either order', () => {
    const { access, scans } = ctx;
    seed(access);
    expect(
      offsets(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'between', value: 10, value2: 50, range: RANGE })),
    ).toEqual([0x100, 0x200]);
    expect(
      offsets(scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'between', value: 50, value2: 10, range: RANGE })),
    ).toEqual([0x100, 0x200]);
  });

  it('narrows by increased-by and decreased-by after a delta measured in the app', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'i32', 10);
    access.write(0x200, 'i32', 20);
    const first = scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'changed' });

    access.write(0x100, 'i32', 15);
    access.write(0x200, 'i32', 21);
    const up = scans.narrow(access, first.scanId, 'increased-by', { value: 5 });
    expect(offsets(up)).toEqual([0x100]);

    access.write(0x100, 'i32', 12);
    access.write(0x200, 'i32', 18);
    // 0x200 was already dropped by the increased-by pass, so only 0x100 (15 -> 12) is left.
    const down = scans.narrow(access, first.scanId, 'decreased-by', { value: 3 });
    expect(offsets(down)).toEqual([0x100]);
  });

  it('requires a value for comparison modes and value2 for between', () => {
    const { access, scans } = ctx;
    expect(() => scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'greater' })).toThrow(/requires a value/);
    expect(() => scans.pass(access, { instanceId: INSTANCE, type: 'i32', mode: 'between', value: 1 })).toThrow(
      /requires value and value2/,
    );
  });

  it('applies the float tolerance to greater-or-equal and between', () => {
    const { access, scans } = ctx;
    access.write(0x100, 'f32', 1.5);
    access.write(0x200, 'f32', 2.5);
    const ge = scans.pass(access, {
      instanceId: INSTANCE,
      type: 'f32',
      mode: 'greater-or-equal',
      value: 1.5000001,
    });
    expect(offsets(ge)).toEqual([0x100, 0x200]);
    const range = scans.pass(access, { instanceId: INSTANCE, type: 'f32', mode: 'between', value: 1.5, value2: 1.5, range: RANGE });
    expect(offsets(range)).toEqual([0x100]);
  });
});

describe('scanText', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  function writeAscii(access: MemoryAccess, offset: number, text: string): void {
    access.writeBytes(offset, Uint8Array.from([...text].map((char) => char.charCodeAt(0))));
  }

  it('finds ascii needles and reports offsets', () => {
    const { access } = ctx;
    writeAscii(access, 0x100, 'hello world');
    writeAscii(access, 0x400, 'Gold: 1200');
    const result = scanText(access, { instanceId: INSTANCE, text: 'Gold' });
    expect(result.matches).toEqual([0x400]);
    expect(result.total).toBe(1);
    expect(result.encoding).toBe('ascii');
  });

  it('finds overlapping and repeated matches, and truncates at maxResults', () => {
    const { access } = ctx;
    writeAscii(access, 0x100, 'abab');
    writeAscii(access, 0x300, 'ab');
    const all = scanText(access, { instanceId: INSTANCE, text: 'ab' });
    expect(all.matches).toEqual([0x100, 0x102, 0x300]);
    const limited = scanText(access, { instanceId: INSTANCE, text: 'ab', maxResults: 2 });
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect(limited.total).toBe(3);
  });

  it('folds ascii case when caseSensitive is false', () => {
    const { access } = ctx;
    writeAscii(access, 0x100, 'Level Up');
    expect(scanText(access, { instanceId: INSTANCE, text: 'level up' }).matches).toEqual([]);
    expect(scanText(access, { instanceId: INSTANCE, text: 'level up', caseSensitive: false }).matches).toEqual([0x100]);
  });

  it('matches utf8 text and raw hex bytes', () => {
    const { access } = ctx;
    access.writeBytes(0x200, new TextEncoder().encode('café'));
    expect(scanText(access, { instanceId: INSTANCE, text: 'café', encoding: 'utf8' }).matches).toEqual([0x200]);
    access.write(0x300, 'i32', 0x12345678);
    expect(scanText(access, { instanceId: INSTANCE, text: '7856 3412', encoding: 'bytes' }).matches).toEqual([0x300]);
  });

  it('respects a byte range and rejects empty or odd hex needles', () => {
    const { access } = ctx;
    writeAscii(access, 0x100, 'score');
    writeAscii(access, 0x2000, 'score');
    expect(scanText(access, { instanceId: INSTANCE, text: 'score', range: { start: 0, end: 0x1000 } }).matches).toEqual([
      0x100,
    ]);
    expect(() => scanText(access, { instanceId: INSTANCE, text: '' })).toThrow(/empty/);
    expect(() => scanText(access, { instanceId: INSTANCE, text: 'abc', encoding: 'bytes' })).toThrow(/even-length/);
  });
});

describe('saved scan round trip', () => {
  const options = { instanceId: INSTANCE, type: 'i32' as const, mode: 'exact' as const, value: 4242 };

  it('serialises a session and adopts it back with the same candidates', () => {
    const first = setup();
    first.access.write(0x100, 'i32', 4242);
    first.access.write(0x400, 'i32', 4242);
    const begun = first.scans.pass(first.access, options);
    const data = first.scans.serialize(begun.scanId);
    expect(data.count).toBe(2);
    expect(typeof data.addresses).toBe('string');

    // A reload means a new page: new memory, same instance id, and a store that has never seen
    // this scan. Adopting must reproduce the candidate list from the stored bytes alone.
    const second = setup();
    second.access.write(0x100, 'i32', 4242);
    second.access.write(0x400, 'i32', 4242);
    const { scanId, summary } = second.scans.adopt(second.access, data);
    expect(summary.matchCount).toBe(2);
    expect(scanId).toMatch(/^s\d+$/);

    // The adopted session narrows like any other, comparing against the values saved with it.
    second.access.write(0x400, 'i32', 9999);
    const narrowed = second.scans.narrow(second.access, scanId, 'changed', {});
    expect(narrowed.matchCount).toBe(1);
    expect(narrowed.sample[0]?.address.offset).toBe(0x400);
    first.scans.drop(begun.scanId);
  });

  it('drops candidates that no longer fit in a smaller heap', () => {
    const first = setup();
    first.access.write(0x18000, 'i32', 7);
    const begun = first.scans.pass(first.access, {
      instanceId: INSTANCE,
      type: 'i32',
      mode: 'exact',
      value: 7,
      range: { start: 0x18000, end: 0x18004 },
    });
    const data = first.scans.serialize(begun.scanId);

    // One page of memory instead of two: the saved address is now past the end.
    const smaller = new MemoryAccess(new WebAssembly.Memory({ initial: 1 }));
    const adopted = new ScanStore().adopt(smaller, data);
    expect(adopted.summary.matchCount).toBe(0);
  });
});
