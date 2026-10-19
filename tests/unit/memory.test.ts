import { describe, expect, it } from 'vitest';
import { BridgeError, type ValueType } from '@wasmcheat/protocol';
import { MemoryAccess, clampInt, defaultTolerance } from '../../packages/page-agent/src/memory';

function freshPage(): MemoryAccess {
  return new MemoryAccess(new WebAssembly.Memory({ initial: 1 }));
}

describe('MemoryAccess', () => {
  it('round-trips every integer and float type', () => {
    const access = freshPage();
    const cases: Array<[ValueType, number]> = [
      ['i8', -100],
      ['u8', 200],
      ['i16', -30000],
      ['u16', 60000],
      ['i32', -2000000000],
      ['u32', 4000000000],
      ['i64', -(2 ** 40)],
      ['u64', 2 ** 40],
      ['f32', 0.5],
      ['f64', -12345.678],
    ];

    let offset = 0;
    for (const [type, value] of cases) {
      access.write(offset, type, value);
      expect(access.read(offset, type), type).toBe(value);
      offset += 16;
    }
  });

  it('wraps out-of-range writes exactly like the wasm type would', () => {
    const access = freshPage();
    access.write(0, 'i8', 300);
    expect(access.read(0, 'i8')).toBe(44);
    access.write(0, 'u8', -1);
    expect(access.read(0, 'u8')).toBe(255);
    access.write(0, 'i32', 2 ** 31);
    expect(access.read(0, 'i32')).toBe(-(2 ** 31));
  });

  it('rounds floats through f32 precision', () => {
    const access = freshPage();
    access.write(0, 'f32', 0.1);
    expect(access.read(0, 'f32')).toBe(Math.fround(0.1));
  });

  it('reads and writes raw byte blocks', () => {
    const access = freshPage();
    access.writeBytes(16, Uint8Array.from([1, 2, 3, 4]));
    expect(Array.from(access.readBytes(16, 4))).toEqual([1, 2, 3, 4]);
  });

  it('rejects reads and writes outside the linear memory', () => {
    const access = freshPage();
    const byteLength = access.byteLength;
    expect(byteLength).toBe(65536);
    expect(() => access.read(byteLength, 'u8')).toThrow(BridgeError);
    expect(() => access.write(byteLength - 2, 'i32', 1)).toThrow(/outside memory/);
    expect(() => access.read(-1, 'u8')).toThrow(/non-negative integer/);
  });

  it('keeps working after memory.grow detaches the old buffer', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const access = new MemoryAccess(memory);
    memory.grow(1);
    expect(access.byteLength).toBe(131072);
    access.write(100_000, 'i32', 4242);
    expect(access.read(100_000, 'i32')).toBe(4242);
    // A cached DataView would still pass here, but a cached typed array would not.
    expect(access.typedArray('i32').length).toBe(131072 / 4);
  });
});

describe('clampInt', () => {
  it('wraps signed and unsigned lanes', () => {
    expect(clampInt(300, 8, true)).toBe(44);
    expect(clampInt(-1, 8, false)).toBe(255);
    expect(clampInt(70000, 16, true)).toBe(4464);
    expect(clampInt(NaN, 32, true)).toBe(0);
    expect(clampInt(2 ** 31, 32, true)).toBe(-(2 ** 31));
  });
});

describe('defaultTolerance', () => {
  it('scales with the magnitude for floats only', () => {
    expect(defaultTolerance('i32', 5)).toBe(0);
    expect(defaultTolerance('f32', 100)).toBeGreaterThan(0);
    expect(defaultTolerance('f64', 1)).toBeGreaterThan(0);
  });
});
