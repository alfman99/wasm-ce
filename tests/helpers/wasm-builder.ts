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

/**
 * A module whose only job is to write memory:
 *   exports: store_at(i32,i32)->(), load_at(i32)->i32, tick()->(), memory
 * `tick` stores at 0x10 and 0x20, so the module has three store sites in two functions.
 */
export function buildStoreModule(): Uint8Array<ArrayBuffer> {
  const module = new Writer();
  module.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  // Types: 0 = (i32,i32)->(), 1 = (i32)->i32, 2 = ()->()
  const types = new Writer().u32(3);
  types.u8(0x60).u32(2).u8(0x7f).u8(0x7f).u32(0);
  types.u8(0x60).u32(1).u8(0x7f).u32(1).u8(0x7f);
  types.u8(0x60).u32(0).u32(0);
  module.section(1, types);

  // Functions: store_at, load_at, tick. No imports and no globals, so a rewriter has to create
  // the sections it appends to.
  module.section(3, new Writer().u32(3).u32(0).u32(1).u32(2));
  module.section(5, new Writer().u32(1).u8(0x00).u32(1));

  const exports = new Writer().u32(4);
  exports.str('store_at').u8(0x00).u32(0);
  exports.str('load_at').u8(0x00).u32(1);
  exports.str('tick').u8(0x00).u32(2);
  exports.str('memory').u8(0x02).u32(0);
  module.section(7, exports);

  module.section(
    10,
    codeSection([
      [0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00], // local.get 0; local.get 1; i32.store
      [0x20, 0x00, 0x28, 0x02, 0x00], // local.get 0; i32.load
      [
        0x41, 0x10, 0x41, 0x01, 0x36, 0x02, 0x00, // i32.const 0x10; i32.const 1; i32.store
        0x41, 0x20, 0x41, 0x02, 0x36, 0x02, 0x00, // i32.const 0x20; i32.const 2; i32.store
      ],
    ]),
  );

  return Uint8Array.from(module.bytes);
}

/**
 * A module whose start function writes 7 to address 0:
 *   exports: peek(i32)->i32, memory
 * A rewriter that leaves the start section's function index alone makes this module fail to
 * instantiate, because slot 0 becomes the callback import.
 */
export function buildStartModule(): Uint8Array<ArrayBuffer> {
  const module = new Writer();
  module.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  // Types: 0 = ()->(), 1 = (i32)->i32
  const types = new Writer().u32(2);
  types.u8(0x60).u32(0).u32(0);
  types.u8(0x60).u32(1).u8(0x7f).u32(1).u8(0x7f);
  module.section(1, types);

  // Function 0 is the start function, function 1 is peek.
  module.section(3, new Writer().u32(2).u32(0).u32(1));
  module.section(5, new Writer().u32(1).u8(0x00).u32(1));

  const exports = new Writer().u32(2);
  exports.str('peek').u8(0x00).u32(1);
  exports.str('memory').u8(0x02).u32(0);
  module.section(7, exports);

  module.section(8, new Writer().u32(0));

  module.section(
    10,
    codeSection([
      [0x41, 0x00, 0x41, 0x07, 0x36, 0x02, 0x00], // i32.const 0; i32.const 7; i32.store
      [0x20, 0x00, 0x28, 0x02, 0x00], // local.get 0; i32.load
    ]),
  );

  return Uint8Array.from(module.bytes);
}

/**
 * A module that reaches its store function through a table, like compiler output does:
 *   exports: write_via_table(i32)->(), write_direct(i32,i32)->(), peek(i32)->i32, memory
 * The single element segment places `write_direct` (function 1) in table slot 0.
 */
export function buildTableModule(): Uint8Array<ArrayBuffer> {
  const module = new Writer();
  module.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  // Types: 0 = (i32,i32)->(), 1 = (i32)->(), 2 = (i32)->i32
  const types = new Writer().u32(3);
  types.u8(0x60).u32(2).u8(0x7f).u8(0x7f).u32(0);
  types.u8(0x60).u32(1).u8(0x7f).u32(0);
  types.u8(0x60).u32(1).u8(0x7f).u32(1).u8(0x7f);
  module.section(1, types);

  // Function 0 = write_via_table (type 1), 1 = write_direct (type 0), 2 = peek (type 2).
  module.section(3, new Writer().u32(3).u32(1).u32(0).u32(2));
  module.section(4, new Writer().u32(1).u8(0x70).u8(0x00).u32(1)); // one funcref slot
  module.section(5, new Writer().u32(1).u8(0x00).u32(1));

  const exports = new Writer().u32(4);
  exports.str('write_via_table').u8(0x00).u32(0);
  exports.str('write_direct').u8(0x00).u32(1);
  exports.str('peek').u8(0x00).u32(2);
  exports.str('memory').u8(0x02).u32(0);
  module.section(7, exports);

  // One active element segment: flags 0, offset expression `i32.const 0`, one function index.
  const elements = new Writer().u32(1).u32(0).raw([0x41, 0x00, 0x0b]).u32(1).u32(1);
  module.section(9, elements);

  module.section(
    10,
    codeSection([
      [0x20, 0x00, 0x41, 0x2a, 0x41, 0x00, 0x11, 0x00, 0x00], // local.get 0; i32.const 42; i32.const 0; call_indirect (type 0) (table 0)
      [0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00], // local.get 0; local.get 1; i32.store
      [0x20, 0x00, 0x28, 0x02, 0x00], // local.get 0; i32.load
    ]),
  );

  return Uint8Array.from(module.bytes);
}

/** A module whose only body starts with the SIMD prefix, which a rewriter must reject. */
export function buildSimdModule(): Uint8Array<ArrayBuffer> {
  const module = new Writer();
  module.raw([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  module.section(1, new Writer().u32(1).u8(0x60).u32(0).u32(0)); // ()->()
  module.section(3, new Writer().u32(1).u32(0));

  const exports = new Writer().u32(1);
  exports.str('simd').u8(0x00).u32(0);
  module.section(7, exports);

  // The prefix alone is enough: the rewriter refuses before reading the subopcode.
  module.section(10, codeSection([[0xfd, 0x0c]]));

  return Uint8Array.from(module.bytes);
}

/** Encodes a code section whose bodies all declare no locals. */
function codeSection(bodies: number[][]): Writer {
  const code = new Writer().u32(bodies.length);
  for (const instructions of bodies) {
    const encoded = new Writer().u32(0).raw(instructions).u8(0x0b);
    code.u32(encoded.bytes.length).raw(encoded.bytes);
  }
  return code;
}

/** Wraps bytes so `WebAssembly.instantiateStreaming` accepts them. */
export function wasmResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
}
