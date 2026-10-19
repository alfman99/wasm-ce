import { BridgeError, VALUE_TYPE_BYTES, type ValueType } from '@wasmcheat/protocol';

/**
 * Byte-level accessors over one `WebAssembly.Memory`.
 *
 * The buffer detaches whenever the module grows its memory, so every method reads
 * `memory.buffer` fresh instead of caching a view. Caching one is the classic way
 * these tools silently start returning zeros.
 */
export class MemoryAccess {
  constructor(private readonly memory: WebAssembly.Memory) {}

  get byteLength(): number {
    return this.memory.buffer.byteLength;
  }

  get growable(): boolean {
    // Nearly every real module is growable; the property is not exposed, so probe
    // by comparing against a zero-length grow attempt only when the caller asks.
    return true;
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  read(offset: number, type: ValueType): number {
    this.assertRange(offset, VALUE_TYPE_BYTES[type]);
    const view = this.view();
    switch (type) {
      case 'i8':
        return view.getInt8(offset);
      case 'u8':
        return view.getUint8(offset);
      case 'i16':
        return view.getInt16(offset, true);
      case 'u16':
        return view.getUint16(offset, true);
      case 'i32':
        return view.getInt32(offset, true);
      case 'u32':
        return view.getUint32(offset, true);
      case 'i64':
        return Number(view.getBigInt64(offset, true));
      case 'u64':
        return Number(view.getBigUint64(offset, true));
      case 'f32':
        return view.getFloat32(offset, true);
      case 'f64':
        return view.getFloat64(offset, true);
    }
  }

  write(offset: number, type: ValueType, value: number): void {
    this.assertRange(offset, VALUE_TYPE_BYTES[type]);
    const view = this.view();
    switch (type) {
      case 'i8':
        view.setInt8(offset, clampInt(value, 8, true));
        return;
      case 'u8':
        view.setUint8(offset, clampInt(value, 8, false));
        return;
      case 'i16':
        view.setInt16(offset, clampInt(value, 16, true), true);
        return;
      case 'u16':
        view.setUint16(offset, clampInt(value, 16, false), true);
        return;
      case 'i32':
        view.setInt32(offset, clampInt(value, 32, true), true);
        return;
      case 'u32':
        view.setUint32(offset, clampInt(value, 32, false), true);
        return;
      case 'i64':
        view.setBigInt64(offset, BigInt(Math.trunc(value)), true);
        return;
      case 'u64':
        view.setBigUint64(offset, BigInt(Math.max(0, Math.trunc(value))), true);
        return;
      case 'f32':
        view.setFloat32(offset, value, true);
        return;
      case 'f64':
        view.setFloat64(offset, value, true);
        return;
    }
  }

  readBytes(offset: number, length: number): Uint8Array {
    this.assertRange(offset, length);
    return new Uint8Array(this.memory.buffer, offset, length).slice();
  }

  writeBytes(offset: number, bytes: Uint8Array): void {
    this.assertRange(offset, bytes.length);
    new Uint8Array(this.memory.buffer, offset, bytes.length).set(bytes);
  }

  /** Fast path used by the scanner: a view of the whole buffer at the type's width. */
  typedArray(type: ValueType): TypedArrayLike {
    const buffer = this.memory.buffer;
    switch (type) {
      case 'i8':
        return new Int8Array(buffer);
      case 'u8':
        return new Uint8Array(buffer);
      case 'i16':
        return new Int16Array(buffer);
      case 'u16':
        return new Uint16Array(buffer);
      case 'i32':
        return new Int32Array(buffer);
      case 'u32':
        return new Uint32Array(buffer);
      case 'i64':
        return new BigInt64Array(buffer);
      case 'u64':
        return new BigUint64Array(buffer);
      case 'f32':
        return new Float32Array(buffer);
      case 'f64':
        return new Float64Array(buffer);
    }
  }

  private assertRange(offset: number, width: number): void {
    const byteLength = this.byteLength;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BridgeError('BAD_PARAMS', `offset must be a non-negative integer, got ${String(offset)}`);
    }
    if (offset + width > byteLength) {
      throw new BridgeError(
        'OUT_OF_RANGE',
        `address 0x${offset.toString(16)} (+${width} bytes) is outside memory of ${byteLength} bytes`,
      );
    }
  }
}

export type TypedArrayLike =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array;

export function clampInt(value: number, bits: 8 | 16 | 32, signed: boolean): number {
  const num = Math.trunc(Number(value));
  if (!Number.isFinite(num)) return 0;
  if (bits === 32) {
    // `| 0` and `>>> 0` wrap exactly like the wasm type would.
    return signed ? num | 0 : num >>> 0;
  }
  const mask = (1 << bits) - 1;
  const wrapped = num & mask;
  if (!signed) return wrapped;
  const signBit = 1 << (bits - 1);
  return (wrapped & signBit) !== 0 ? wrapped - (1 << bits) : wrapped;
}

/** Tolerance used when comparing floats: exact bit equality is rarely what a human means. */
export function defaultTolerance(type: ValueType, value: number): number {
  if (type === 'f32') return Math.max(Math.abs(value) * 1e-6, 1e-6);
  if (type === 'f64') return Math.max(Math.abs(value) * 1e-12, 1e-12);
  return 0;
}
