/**
 * Hand-rolled .wasm encoder for tests and fixtures.
 *
 * Tests must not depend on clang/emcc being installed, and a real module is the only
 * way to prove the registry hooks `WebAssembly.instantiate` rather than a mock.
 */

class Writer {
  readonly bytes: number[] = [];

  u8(byte: number): this {
    this.bytes.push(byte & 0xff);
    return this;
  }

  raw(values: number[]): this {
    for (const value of values) this.bytes.push(value & 0xff);
    return this;
  }

  u32(value: number): this {
    let remaining = value >>> 0;
    do {
      const byte = remaining & 0x7f;
      remaining >>>= 7;
      this.bytes.push(remaining === 0 ? byte : byte | 0x80);
    } while (remaining !== 0);
    return this;
  }

  i32(value: number): this {
    let remaining = value | 0;
    let more = true;
    while (more) {
      const byte = remaining & 0x7f;
      remaining >>= 7;
      const signBit = (byte & 0x40) !== 0;
      more = !((remaining === 0 && !signBit) || (remaining === -1 && signBit));
      this.bytes.push(more ? byte | 0x80 : byte);
    }
    return this;
  }

  str(value: string): this {
    const encoded = new TextEncoder().encode(value);
    this.u32(encoded.length);
    for (const byte of encoded) this.bytes.push(byte);
    return this;
  }

  section(id: number, body: Writer): this {
    this.u8(id);
    this.u32(body.bytes.length);
    for (const byte of body.bytes) this.bytes.push(byte);
    return this;
  }
}

export interface DemoModuleOptions {
  /** Import the memory from `env.memory` instead of exporting it. */
  importMemory?: boolean;
  /** Initial memory size in 64 KiB pages. */
  pages?: number;
}

/**
 * A tiny module shaped like a real one:
 *   exports: add(i32,i32)->i32, bump()->(), read_score()->i32, shout()->(), memory
 *   imports: env.log(i32)->(), env.memory when `importMemory`
 */
export function buildDemoModule(options: DemoModuleOptions = {}): Uint8Array<ArrayBuffer> {
  const pages = options.pages ?? 1;
  const module = new Writer();
  module.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  // Types: 0 = (i32,i32)->i32, 1 = (i32)->(), 2 = ()->(), 3 = ()->i32
  const types = new Writer().u32(4);
  types.u8(0x60).u32(2).u8(0x7f).u8(0x7f).u32(1).u8(0x7f);
  types.u8(0x60).u32(1).u8(0x7f).u32(0);
  types.u8(0x60).u32(0).u32(0);
  types.u8(0x60).u32(0).u32(1).u8(0x7f);
  module.section(1, types);

  // Imports: env.log (func) and optionally env.memory.
  const importCount = options.importMemory ? 2 : 1;
  const imports = new Writer().u32(importCount);
  imports.str('env').str('log').u8(0x00).u32(1);
  if (options.importMemory) {
    imports.str('env').str('memory').u8(0x02).u8(0x00).u32(pages);
  }
  module.section(2, imports);

  // Functions: add, bump, read_score, shout
  module.section(3, new Writer().u32(4).u32(0).u32(2).u32(3).u32(2));

  if (!options.importMemory) {
    module.section(5, new Writer().u32(1).u8(0x00).u32(pages));
  }

  // Global 0: mutable i32 score, starts at 0.
  module.section(6, new Writer().u32(1).u8(0x7f).u8(0x01).u8(0x41).i32(0).u8(0x0b));

  const exports = new Writer().u32(options.importMemory ? 4 : 5);
  exports.str('add').u8(0x00).u32(1);
  exports.str('bump').u8(0x00).u32(2);
  exports.str('read_score').u8(0x00).u32(3);
  exports.str('shout').u8(0x00).u32(4);
  if (!options.importMemory) exports.str('memory').u8(0x02).u32(0);
  module.section(7, exports);

  const bodies: number[][] = [
    body([0x20, 0x00, 0x20, 0x01, 0x6a]), // local.get 0; local.get 1; i32.add
    body([0x23, 0x00, 0x41, 0x01, 0x6a, 0x24, 0x00]), // global.get 0; i32.const 1; i32.add; global.set 0
    body([0x23, 0x00]), // global.get 0
    body([0x41, 0x07, 0x10, 0x00]), // i32.const 7; call 0 (env.log)
  ];
  const code = new Writer().u32(bodies.length);
  for (const source of bodies) {
    const encoded = new Writer().u32(0).raw(source).u8(0x0b);
    code.u32(encoded.bytes.length);
    for (const byte of encoded.bytes) code.bytes.push(byte);
  }
  module.section(10, code);

  return Uint8Array.from(module.bytes);
}

function body(instructions: number[]): number[] {
  return instructions;
}

/** A module with an exported memory holding a known pattern, used by scanner tests. */
export function buildMemoryModule(pages = 1): Uint8Array<ArrayBuffer> {
  const module = new Writer();
  module.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  const types = new Writer().u32(1);
  types.u8(0x60).u32(0).u32(1).u8(0x7f);
  module.section(1, types);
  module.section(3, new Writer().u32(1).u32(0));
  module.section(5, new Writer().u32(1).u8(0x00).u32(pages));

  const exports = new Writer().u32(2);
  exports.str('peek').u8(0x00).u32(0);
  exports.str('memory').u8(0x02).u32(0);
  module.section(7, exports);

  const code = new Writer().u32(1);
  const encoded = new Writer().u32(0).raw([0x41, 0x00]).u8(0x0b); // i32.const 0
  code.u32(encoded.bytes.length).raw(encoded.bytes);
  module.section(10, code);

  return Uint8Array.from(module.bytes);
}

/** Wraps bytes so `WebAssembly.instantiateStreaming` accepts them. */
export function wasmResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
}
