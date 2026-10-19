/**
 * Reads the export section to map wasm function indices back to names.
 *
 * A write watchpoint reports the index of the function that performed the store — that is the
 * only identity the engine gives us — and the export section is the only place where those
 * indices are written down. Reading it is a few dozen lines, so it beats shipping a parser
 * dependency just for attribution.
 */

const SECTION_EXPORT = 7;
const EXTERNAL_KIND_FUNCTION = 0x00;

class Cursor {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.position >= this.bytes.length;
  }

  u8(): number {
    const value = this.bytes[this.position];
    if (value === undefined) throw new RangeError('unexpected end of wasm binary');
    this.position += 1;
    return value;
  }

  /** Unsigned LEB128 that stays a JS number; module sizes never exceed 2^53 here. */
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 49) throw new RangeError('LEB128 value is too large');
    }
  }

  name(): string {
    const length = this.u32();
    const end = this.position + length;
    if (end > this.bytes.length) throw new RangeError('export name runs past the section');
    const slice = this.bytes.subarray(this.position, end);
    this.position = end;
    return new TextDecoder().decode(slice);
  }

  skip(length: number): void {
    this.position += length;
    if (this.position > this.bytes.length) throw new RangeError('section runs past the module');
  }

  sub(length: number): Cursor {
    const end = this.position + length;
    if (end > this.bytes.length) throw new RangeError('section runs past the module');
    const cursor = new Cursor(this.bytes.subarray(this.position, end));
    this.position = end;
    return cursor;
  }
}

/**
 * Function index → export name. Functions the module does not export are absent, which is why
 * callers fall back to a bare `wasm-function[N]` label.
 */
export function readFunctionExports(bytes: Uint8Array): Record<number, string> {
  const names: Record<number, string> = {};
  if (bytes.length < 8) return names;
  const cursor = new Cursor(bytes);
  cursor.skip(8);
  try {
    while (!cursor.done) {
      const id = cursor.u8();
      const section = cursor.sub(cursor.u32());
      if (id !== SECTION_EXPORT) continue;
      const count = section.u32();
      for (let i = 0; i < count; i += 1) {
        const name = section.name();
        const kind = section.u8();
        const index = section.u32();
        if (kind === EXTERNAL_KIND_FUNCTION) names[index] = name;
      }
    }
  } catch {
    // A truncated or unexpected section is not worth failing an attach over.
  }
  return names;
}
