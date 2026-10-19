/**
 * Wasm binary rewriting for write watchpoints.
 *
 * A running WebAssembly instance gives no way to observe a memory write: the engine executes
 * `i32.store` without telling anyone. The only way to answer "which function wrote this
 * address?" is to change the module before it is compiled — append a guarded callback after
 * every store instruction — which is what this package does.
 *
 * The appended sequence is straight-line code:
 *
 *     global.get <flags>     ; arming flag, 0 until the host calls __wc_arm(1)
 *     if                     ; empty block type
 *       i32.const <function> ; the function this call site belongs to
 *       call <on_store>      ; the single host import
 *     end
 *
 * A store leaves the operand stack empty, so this can be appended without touching locals or
 * the stack — which is why the rewriter is far simpler than one that has to prepend checks.
 * While the flag is 0 the cost is one `global.get` and one not-taken branch per store, and no
 * JavaScript ever runs.
 *
 * Adding the `on_store` import moves every defined function up one slot in the function index
 * space, so the rewriter repairs every place a function index is encoded: function exports,
 * `call`, `ref.func`, the start section and element segments. The index reported at runtime is
 * therefore an index of the *instrumented* module; a host turns it into a name by reading that
 * module's export section.
 */

import { BridgeError } from '@wasmcheat/protocol';

/** Name the instrumented module imports its callback from. */
const CALLBACK_MODULE = '__wasmcheat';

/** Field the instrumented module imports its callback as. */
const CALLBACK_FIELD = 'on_store';

/** Export the host calls to arm and disarm the callback. */
const ARM_EXPORT = '__wc_arm';

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

const SECTION_NAME = [
  'custom',
  'type',
  'import',
  'function',
  'table',
  'memory',
  'global',
  'export',
  'start',
  'element',
  'code',
  'data',
  'data count',
];

/** Section ids in the order the binary format requires; 12 (data count) precedes the code. */
const SECTION_ORDER: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  12: 10,
  10: 11,
  11: 12,
};

const UTF8 = new TextEncoder();

const IDENTITY = (index: number): number => index;

export interface InstrumentedModule {
  /** Rewritten module, ready for `new WebAssembly.Module` or `WebAssembly.instantiate`. */
  bytes: Uint8Array<ArrayBuffer>;
  importModule: '__wasmcheat';
  importField: 'on_store';
  armExport: '__wc_arm';
  /** Injected call sites: every store instruction plus the bulk-memory writes. */
  storeCount: number;
  /** Defined functions in the input module, i.e. how many code bodies were rewritten. */
  functionCount: number;
}

/**
 * Rewrites `bytes` so every memory write reports the instrumented module's function index to
 * the `__wasmcheat.on_store` import while `__wc_arm(1)` is in effect.
 *
 * Throws `BridgeError` with code `UNSUPPORTED`, naming the opcode or section, when the module
 * uses something this rewriter cannot decode; the input bytes are never partially rewritten.
 */
export function instrumentModule(bytes: Uint8Array): InstrumentedModule {
  const sections = parseSections(bytes);
  const layout = inspectModule(sections);

  const callbackTypeIndex = layout.typeCount;
  const callbackImportIndex = layout.importedFunctionCount;
  const flagsGlobalIndex = layout.globalCount;
  const armFunctionIndex = layout.importedFunctionCount + 1 + layout.functionCount;

  // The callback import is appended after the existing imports, so it takes the first slot the
  // defined functions used to occupy: every defined function index grows by one.
  const context: RewriteContext = {
    shiftFunctionIndex: (index) => (index >= layout.importedFunctionCount ? index + 1 : index),
    injectionFor: (definedFunctionIndex) =>
      new Writer()
        .u8(0x23)
        .u32(flagsGlobalIndex) // global.get <flags>
        .u8(0x04)
        .u8(0x40) // if, no result
        .u8(0x41)
        .s32(layout.importedFunctionCount + 1 + definedFunctionIndex) // i32.const <function>
        .u8(0x10)
        .u32(callbackImportIndex) // call <on_store>
        .u8(0x0b) // end
        .toBytes(),
    armBody: new Writer()
      .u32(0) // no local declarations
      .u8(0x20)
      .u8(0x00) // local.get 0
      .u8(0x24)
      .u32(flagsGlobalIndex) // global.set <flags>
      .u8(0x0b)
      .toBytes(),
  };

  let storeCount = 0;
  for (const section of sections) {
    switch (section.id) {
      case 1:
        section.payload = appendCallbackType(section.payload);
        break;
      case 2:
        section.payload = appendCallbackImport(section.payload, callbackTypeIndex);
        break;
      case 3:
        section.payload = appendArmFunction(section.payload, callbackTypeIndex);
        break;
      case 6:
        section.payload = appendFlagsGlobal(section.payload, context);
        break;
      case 7:
        section.payload = appendArmExport(section.payload, context, armFunctionIndex);
        break;
      case 8:
        section.payload = shiftStartFunction(section.payload, context);
        break;
      case 9:
        section.payload = shiftElementFunctions(section.payload, context);
        break;
      case 10: {
        const rewritten = rewriteCodeSection(section.payload, context);
        section.payload = rewritten.payload;
        storeCount += rewritten.storeCount;
        break;
      }
      default:
        // Table, memory, data count, data and custom sections carry no function indices.
        break;
    }
  }

  if (!sections.some((section) => section.id === 2)) {
    insertSection(sections, { id: 2, payload: appendCallbackImport(null, callbackTypeIndex) });
  }
  if (!sections.some((section) => section.id === 6)) {
    insertSection(sections, { id: 6, payload: appendFlagsGlobal(null, context) });
  }
  if (!sections.some((section) => section.id === 7)) {
    insertSection(sections, { id: 7, payload: appendArmExport(null, context, armFunctionIndex) });
  }

  return {
    bytes: assembleModule(sections),
    importModule: CALLBACK_MODULE,
    importField: CALLBACK_FIELD,
    armExport: ARM_EXPORT,
    storeCount,
    functionCount: layout.functionCount,
  };
}

interface Section {
  id: number;
  payload: Uint8Array;
}

interface ModuleLayout {
  typeCount: number;
  importedFunctionCount: number;
  functionCount: number;
  globalCount: number;
}

interface RewriteContext {
  /** Maps a function index of the input module to its index once the callback import is added. */
  shiftFunctionIndex(index: number): number;
  /** Guard + callback bytes appended after every write in the given defined function. */
  injectionFor(definedFunctionIndex: number): Uint8Array<ArrayBuffer>;
  /** Body of the `__wc_arm` function the code section gains. */
  armBody: Uint8Array<ArrayBuffer>;
}

/** Every rejection uses the same code: the caller asked for a rewrite we cannot produce. */
function unsupported(message: string): BridgeError {
  return new BridgeError('UNSUPPORTED', message);
}

class Writer {
  private readonly out: number[] = [];

  u8(value: number): this {
    this.out.push(value & 0xff);
    return this;
  }

  bytes(values: Uint8Array): this {
    for (const value of values) this.out.push(value);
    return this;
  }

  /** Unsigned LEB128, the encoding of counts, indices, section sizes and memory offsets. */
  u32(value: number): this {
    let remaining = value >>> 0;
    do {
      const byte = remaining & 0x7f;
      remaining >>>= 7;
      this.out.push(remaining === 0 ? byte : byte | 0x80);
    } while (remaining !== 0);
    return this;
  }

  /** Signed LEB128, the encoding `i32.const` expects. */
  s32(value: number): this {
    let remaining = value | 0;
    for (;;) {
      const byte = remaining & 0x7f;
      remaining >>= 7;
      const signSet = (byte & 0x40) !== 0;
      if ((remaining === 0 && !signSet) || (remaining === -1 && signSet)) {
        this.out.push(byte);
        return this;
      }
      this.out.push(byte | 0x80);
    }
  }

  name(value: string): this {
    const encoded = UTF8.encode(value);
    return this.u32(encoded.length).bytes(encoded);
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.out);
  }
}

class Reader {
  private position: number;

  constructor(
    private readonly source: Uint8Array,
    start = 0,
  ) {
    this.position = start;
  }

  get offset(): number {
    return this.position;
  }

  get atEnd(): boolean {
    return this.position >= this.source.length;
  }

  seek(position: number): void {
    this.position = position;
  }

  u8(): number {
    const byte = this.source[this.position];
    if (byte === undefined) throw unsupported('unexpected end of module bytes');
    this.position += 1;
    return byte;
  }

  bytes(count: number): Uint8Array {
    if (count < 0 || this.position + count > this.source.length) {
      throw unsupported('unexpected end of module bytes');
    }
    const slice = this.source.subarray(this.position, this.position + count);
    this.position += count;
    return slice;
  }

  skip(count: number): void {
    this.bytes(count);
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw unsupported('LEB128 integer longer than 5 bytes');
  }

  /** Skips a signed LEB128 whose value is never needed: a block type or a constant literal. */
  skipLeb(maxBytes: number): void {
    for (let index = 0; index < maxBytes; index += 1) {
      if ((this.u8() & 0x80) === 0) return;
    }
    throw unsupported('LEB128 value longer than expected');
  }
}

interface SequenceRewrite {
  bytes: Uint8Array<ArrayBuffer>;
  /** Offset just past the terminating `end`, so callers can continue from it. */
  end: number;
  storeCount: number;
}

/**
 * Re-emits one instruction sequence (a function body's instructions or a constant expression),
 * shifting every function index and appending the guarded callback after every memory write.
 */
function rewriteInstructionSequence(
  source: Uint8Array,
  start: number,
  options: { shiftFunctionIndex: (index: number) => number; injection: Uint8Array | null },
): SequenceRewrite {
  const reader = new Reader(source, start);
  const out = new Writer();
  let depth = 0;
  let storeCount = 0;
  let terminated = false;

  while (!terminated) {
    if (reader.atEnd) throw unsupported('instruction sequence ends without its final `end`');
    const instructionStart = reader.offset;
    const opcode = reader.u8();
    let shiftedIndex: number | null = null;
    // 0x36-0x3e are the i32/i64/f32/f64 stores; the 0xFC cases below add the bulk writes.
    let writes = opcode >= 0x36 && opcode <= 0x3e;

    switch (opcode) {
      case 0x00: // unreachable
      case 0x01: // nop
      case 0x05: // else
      case 0x0a: // throw_ref
      case 0x0f: // return
      case 0x1a: // drop
      case 0x1b: // select
      case 0xd1: // ref.is_null
        break;
      case 0x02: // block
      case 0x03: // loop
      case 0x04: // if
      case 0x06: // try (legacy exception handling)
        reader.skipLeb(5); // block type: 0x40, a value type, or an s33 type index
        depth += 1;
        break;
      case 0x07: // catch <tag>
      case 0x08: // throw <tag>
      case 0x09: // rethrow <depth>
        reader.u32();
        break;
      case 0x0b: // end
        if (depth === 0) terminated = true;
        else depth -= 1;
        break;
      case 0x0c: // br <depth>
      case 0x0d: // br_if <depth>
        reader.u32();
        break;
      case 0x0e: {
        // br_table <targets...> <default>
        const targets = reader.u32();
        for (let index = 0; index < targets; index += 1) reader.u32();
        reader.u32();
        break;
      }
      case 0x10: // call <function>
      case 0xd2: // ref.func <function>
        shiftedIndex = reader.u32();
        break;
      case 0x11: // call_indirect <type> <table>
        reader.u32();
        reader.u32();
        break;
      case 0x1c: {
        // select with an explicit list of result types
        const types = reader.u32();
        reader.skip(types);
        break;
      }
      case 0x20: // local.get
      case 0x21: // local.set
      case 0x22: // local.tee
      case 0x23: // global.get
      case 0x24: // global.set
      case 0x25: // table.get
      case 0x26: // table.set
      case 0x3f: // memory.size <memory>
      case 0x40: // memory.grow <memory>
        reader.u32();
        break;
      case 0x41: // i32.const
        reader.skipLeb(5);
        break;
      case 0x42: // i64.const
        reader.skipLeb(10);
        break;
      case 0x43: // f32.const
        reader.skip(4);
        break;
      case 0x44: // f64.const
        reader.skip(8);
        break;
      case 0xd0: // ref.null <heap type>
        reader.u8();
        break;
      case 0xfc: {
        // Bulk memory and table operations, prefixed.
        const subopcode = reader.u32();
        switch (subopcode) {
          case 0:
          case 1:
          case 2:
          case 3:
          case 4:
          case 5:
          case 6:
          case 7: // trunc_sat: no immediates
            break;
          case 8: // memory.init <data> <memory>
            reader.u32();
            reader.u32();
            writes = true;
            break;
          case 9: // data.drop <data>
            reader.u32();
            break;
          case 10: // memory.copy <memory> <memory>
            reader.u32();
            reader.u32();
            writes = true;
            break;
          case 11: // memory.fill <memory>
            reader.u32();
            writes = true;
            break;
          case 12: // table.init <element> <table>
            reader.u32();
            reader.u32();
            break;
          case 13: // elem.drop <element>
            reader.u32();
            break;
          case 14: // table.copy <table> <table>
            reader.u32();
            reader.u32();
            break;
          case 15: // table.grow
          case 16: // table.size
          case 17: // table.fill
            reader.u32();
            break;
          default:
            throw unsupported(`unknown 0xFC subopcode ${subopcode}`);
        }
        break;
      }
      case 0xfd:
        throw unsupported('SIMD opcode 0xFD is not supported');
      case 0xfe:
        throw unsupported('atomic opcode 0xFE is not supported');
      default:
        if (opcode >= 0x28 && opcode <= 0x3e) {
          // Loads and stores: alignment then offset.
          reader.u32();
          reader.u32();
          break;
        }
        if (opcode >= 0x45 && opcode <= 0xc4) break; // numeric instructions, no immediates
        throw unsupported(`unknown opcode 0x${opcode.toString(16)}`);
    }

    if (shiftedIndex === null) {
      out.bytes(source.subarray(instructionStart, reader.offset));
    } else {
      out.u8(opcode).u32(options.shiftFunctionIndex(shiftedIndex));
    }
    if (writes && options.injection !== null) {
      out.bytes(options.injection);
      storeCount += 1;
    }
  }

  return { bytes: out.toBytes(), end: reader.offset, storeCount };
}

function parseSections(bytes: Uint8Array): Section[] {
  if (bytes.length < HEADER.length) throw unsupported('module is shorter than the wasm header');
  for (let index = 0; index < 4; index += 1) {
    if (bytes[index] !== HEADER[index]) throw unsupported('missing wasm magic (\\0asm)');
  }
  for (let index = 4; index < HEADER.length; index += 1) {
    if (bytes[index] !== HEADER[index]) throw unsupported('only wasm binary version 1 is supported');
  }

  const reader = new Reader(bytes, HEADER.length);
  const sections: Section[] = [];
  let lastOrder = 0;
  while (!reader.atEnd) {
    const id = reader.u8();
    const size = reader.u32();
    const payload = reader.bytes(size);
    if (id === 0) {
      sections.push({ id, payload });
      continue;
    }
    const order = SECTION_ORDER[id];
    if (order === undefined) throw unsupported(`unknown section id ${id}`);
    if (order <= lastOrder) throw unsupported(`section "${sectionName(id)}" is missing or out of order`);
    lastOrder = order;
    sections.push({ id, payload });
  }
  return sections;
}

function inspectModule(sections: Section[]): ModuleLayout {
  const typeCount = countTypes(requireSection(sections, 1).payload);
  const importSection = sections.find((section) => section.id === 2);
  const imports =
    importSection === undefined ? { functionCount: 0, memoryCount: 0 } : inspectImports(importSection.payload);
  const memorySection = sections.find((section) => section.id === 5);
  const declaredMemoryCount = memorySection === undefined ? 0 : countMemories(memorySection.payload);
  if (imports.memoryCount + declaredMemoryCount > 1) throw unsupported('multiple memories are not supported');
  const functionCount = countFunctions(requireSection(sections, 3).payload);
  const bodyCount = new Reader(requireSection(sections, 10).payload).u32();
  if (bodyCount !== functionCount) {
    throw unsupported(`code section holds ${bodyCount} bodies but the function section declares ${functionCount}`);
  }
  const globalSection = sections.find((section) => section.id === 6);
  return {
    typeCount,
    importedFunctionCount: imports.functionCount,
    functionCount,
    globalCount: globalSection === undefined ? 0 : countGlobals(globalSection.payload),
  };
}

function requireSection(sections: Section[], id: number): Section {
  const section = sections.find((candidate) => candidate.id === id);
  if (section === undefined) throw unsupported(`missing ${sectionName(id)} section`);
  return section;
}

function sectionName(id: number): string {
  return SECTION_NAME[id] ?? `id ${id}`;
}

function sectionOrder(id: number): number {
  return SECTION_ORDER[id] ?? 0;
}

function countTypes(payload: Uint8Array): number {
  const reader = new Reader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    const form = reader.u8();
    if (form !== 0x60) {
      throw unsupported(`type ${index} uses type form 0x${form.toString(16)}, only function types are supported`);
    }
    reader.skip(reader.u32()); // parameter value types, one byte each
    reader.skip(reader.u32()); // result value types
  }
  return count;
}

function inspectImports(payload: Uint8Array): { functionCount: number; memoryCount: number } {
  const reader = new Reader(payload);
  const count = reader.u32();
  let functionCount = 0;
  let memoryCount = 0;
  for (let index = 0; index < count; index += 1) {
    reader.skip(reader.u32()); // module name
    reader.skip(reader.u32()); // field name
    const kind = reader.u8();
    switch (kind) {
      case 0x00: // function: type index
        reader.u32();
        functionCount += 1;
        break;
      case 0x01: // table: reference type then limits
        reader.u8();
        skipLimits(reader);
        break;
      case 0x02: // memory: limits
        skipLimits(reader);
        memoryCount += 1;
        break;
      case 0x03: // global: value type then mutability
        reader.u8();
        reader.u8();
        break;
      case 0x04: // tag: attribute then type index
        reader.u8();
        reader.u32();
        break;
      default:
        throw unsupported(`import ${index} has unknown kind 0x${kind.toString(16)}`);
    }
  }
  return { functionCount, memoryCount };
}

function skipLimits(reader: Reader): void {
  const flags = reader.u8();
  if ((flags & 0x02) !== 0) throw unsupported('shared memory (threads) is not supported');
  if ((flags & 0x04) !== 0) throw unsupported('64-bit memories are not supported');
  reader.u32(); // minimum
  if ((flags & 0x01) !== 0) reader.u32(); // maximum
}

function countMemories(payload: Uint8Array): number {
  const reader = new Reader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) skipLimits(reader);
  return count;
}

function countFunctions(payload: Uint8Array): number {
  const reader = new Reader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) reader.u32(); // type index
  return count;
}

function countGlobals(payload: Uint8Array): number {
  const reader = new Reader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    reader.u8(); // value type
    reader.u8(); // mutability
    const expression = rewriteInstructionSequence(payload, reader.offset, {
      shiftFunctionIndex: IDENTITY,
      injection: null,
    });
    reader.seek(expression.end);
  }
  return count;
}

function appendCallbackType(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const reader = new Reader(payload);
  const count = reader.u32();
  return new Writer()
    .u32(count + 1)
    .bytes(payload.subarray(reader.offset))
    .u8(0x60)
    .u32(1)
    .u8(0x7f)
    .u32(0) // (func (param i32))
    .toBytes();
}

function appendCallbackImport(payload: Uint8Array | null, typeIndex: number): Uint8Array<ArrayBuffer> {
  const imports = new Writer();
  if (payload === null) {
    imports.u32(1);
  } else {
    const reader = new Reader(payload);
    imports.u32(reader.u32() + 1).bytes(payload.subarray(reader.offset));
  }
  return imports.name(CALLBACK_MODULE).name(CALLBACK_FIELD).u8(0x00).u32(typeIndex).toBytes();
}

function appendArmFunction(payload: Uint8Array, typeIndex: number): Uint8Array<ArrayBuffer> {
  const reader = new Reader(payload);
  const count = reader.u32();
  return new Writer().u32(count + 1).bytes(payload.subarray(reader.offset)).u32(typeIndex).toBytes();
}

function appendFlagsGlobal(payload: Uint8Array | null, context: RewriteContext): Uint8Array<ArrayBuffer> {
  const globals = new Writer();
  if (payload === null) {
    globals.u32(1);
  } else {
    const reader = new Reader(payload);
    const count = reader.u32();
    globals.u32(count + 1);
    for (let index = 0; index < count; index += 1) {
      const valueType = reader.u8();
      const mutability = reader.u8();
      const expression = rewriteInstructionSequence(payload, reader.offset, {
        shiftFunctionIndex: context.shiftFunctionIndex,
        injection: null,
      });
      globals.u8(valueType).u8(mutability).bytes(expression.bytes);
      reader.seek(expression.end);
    }
  }
  // Mutable i32 initialised to 0, so an untouched module never takes the callback branch.
  return globals.u8(0x7f).u8(0x01).u8(0x41).s32(0).u8(0x0b).toBytes();
}

function appendArmExport(
  payload: Uint8Array | null,
  context: RewriteContext,
  armFunctionIndex: number,
): Uint8Array<ArrayBuffer> {
  const exports = new Writer();
  if (payload === null) {
    exports.u32(1);
  } else {
    const reader = new Reader(payload);
    const count = reader.u32();
    exports.u32(count + 1);
    for (let index = 0; index < count; index += 1) {
      const nameLength = reader.u32();
      const name = reader.bytes(nameLength);
      const kind = reader.u8();
      const target = reader.u32();
      exports.u32(nameLength).bytes(name).u8(kind);
      // Only function exports point into the shifted index space; table, memory and global
      // indices are unchanged because we never insert into those spaces.
      exports.u32(kind === 0x00 ? context.shiftFunctionIndex(target) : target);
    }
  }
  return exports.name(ARM_EXPORT).u8(0x00).u32(armFunctionIndex).toBytes();
}

function shiftStartFunction(payload: Uint8Array, context: RewriteContext): Uint8Array<ArrayBuffer> {
  const reader = new Reader(payload);
  const index = reader.u32();
  if (!reader.atEnd) throw unsupported('start section holds more than one function index');
  return new Writer().u32(context.shiftFunctionIndex(index)).toBytes();
}

function shiftElementFunctions(payload: Uint8Array, context: RewriteContext): Uint8Array<ArrayBuffer> {
  const reader = new Reader(payload);
  const count = reader.u32();
  const elements = new Writer().u32(count);

  const copyExpression = (): void => {
    const expression = rewriteInstructionSequence(payload, reader.offset, {
      shiftFunctionIndex: context.shiftFunctionIndex,
      injection: null,
    });
    elements.bytes(expression.bytes);
    reader.seek(expression.end);
  };
  const copyByte = (): void => {
    elements.u8(reader.u8());
  };
  const copyIndex = (): void => {
    elements.u32(reader.u32());
  };
  const copyFunctionIndices = (): void => {
    const total = reader.u32();
    elements.u32(total);
    for (let index = 0; index < total; index += 1) elements.u32(context.shiftFunctionIndex(reader.u32()));
  };
  const copyExpressions = (): void => {
    const total = reader.u32();
    elements.u32(total);
    for (let index = 0; index < total; index += 1) copyExpression();
  };

  for (let index = 0; index < count; index += 1) {
    const flags = reader.u32();
    elements.u32(flags);
    switch (flags) {
      case 0: // active, table 0, funcref: offset expression then function indices
        copyExpression();
        copyFunctionIndices();
        break;
      case 1: // passive: element kind then function indices
        copyByte();
        copyFunctionIndices();
        break;
      case 2: // active with an explicit table index
        copyIndex();
        copyExpression();
        copyByte();
        copyFunctionIndices();
        break;
      case 3: // declarative
        copyByte();
        copyFunctionIndices();
        break;
      case 4: // active, table 0, funcref expressions
        copyExpression();
        copyExpressions();
        break;
      case 5: // passive, reference type then expressions
        copyByte();
        copyExpressions();
        break;
      case 6: // active, explicit table index, reference type then expressions
        copyIndex();
        copyExpression();
        copyByte();
        copyExpressions();
        break;
      case 7: // declarative, reference type then expressions
        copyByte();
        copyExpressions();
        break;
      default:
        throw unsupported(`element segment ${index} uses flags ${flags}, which this rewriter cannot decode`);
    }
  }
  if (!reader.atEnd) throw unsupported('element section holds trailing bytes');
  return elements.toBytes();
}

function rewriteCodeSection(
  payload: Uint8Array,
  context: RewriteContext,
): { payload: Uint8Array<ArrayBuffer>; storeCount: number } {
  const reader = new Reader(payload);
  const count = reader.u32();
  const code = new Writer().u32(count + 1);
  let storeCount = 0;

  for (let definedFunctionIndex = 0; definedFunctionIndex < count; definedFunctionIndex += 1) {
    const bodySize = reader.u32();
    const bodyStart = reader.offset;
    const bodyEnd = bodyStart + bodySize;
    if (bodyEnd > payload.length) {
      throw unsupported(`code body ${definedFunctionIndex} runs past the end of the code section`);
    }
    const body = payload.subarray(bodyStart, bodyEnd);
    const locals = new Reader(body);
    const localGroups = locals.u32();
    for (let group = 0; group < localGroups; group += 1) {
      locals.u32(); // how many locals this group declares
      locals.u8(); // their value type
    }
    const localsEnd = bodyStart + locals.offset;
    const sequence = rewriteInstructionSequence(payload, localsEnd, {
      shiftFunctionIndex: context.shiftFunctionIndex,
      injection: context.injectionFor(definedFunctionIndex),
    });
    if (sequence.end !== bodyEnd) {
      throw unsupported(`code body ${definedFunctionIndex} does not end where its declared size says it does`);
    }
    code.u32(localsEnd - bodyStart + sequence.bytes.length);
    code.bytes(payload.subarray(bodyStart, localsEnd));
    code.bytes(sequence.bytes);
    storeCount += sequence.storeCount;
    reader.seek(bodyEnd);
  }

  code.u32(context.armBody.length).bytes(context.armBody);
  return { payload: code.toBytes(), storeCount };
}

function insertSection(sections: Section[], section: Section): void {
  const order = sectionOrder(section.id);
  const position = sections.findIndex((candidate) => candidate.id !== 0 && sectionOrder(candidate.id) > order);
  if (position === -1) sections.push(section);
  else sections.splice(position, 0, section);
}

function assembleModule(sections: Section[]): Uint8Array<ArrayBuffer> {
  const module = new Writer();
  for (const byte of HEADER) module.u8(byte);
  for (const section of sections) module.u8(section.id).u32(section.payload.length).bytes(section.payload);
  return module.toBytes();
}
