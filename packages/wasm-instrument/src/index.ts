/**
 * Wasm binary rewriting for memory watchpoints.
 *
 * A running WebAssembly instance gives no way to observe a memory access: the engine executes
 * `i32.load` and `i32.store` without telling anyone. The only way to answer "which function
 * touched this address?" is to change the module before it is compiled — append a guarded
 * callback after every store, and put a guarded probe call before every load.
 *
 * Writes are the easy direction, because a store leaves the operand stack empty. Straight-line
 * code can simply follow it:
 *
 *     global.get <flags>     ; arming flag, 0 until the host calls __wc_arm(1)
 *     if                     ; empty block type
 *       i32.const <function> ; the function this call site belongs to
 *       call <on_store>      ; host import
 *     end
 *
 * A load is not empty — `[addr] -> LOAD -> [value]` — so the rewriter calls a generated probe
 * immediately before it and lets the load run untouched afterwards:
 *
 *     call <probe>           ; (i32) -> (i32), reports the address and returns it unchanged
 *     i32.load <align> <off> ; the original instruction, immediates re-emitted as they were
 *
 * The address is already on the stack when the probe runs, and the probe is stack-neutral, so
 * the load sees exactly the stack it expects. That is why this rewriter needs no stack
 * analysis at all: the load is never moved, only preceded. One probe exists per reading
 * function, with that function's index baked in as a constant.
 *
 * Prefixed opcodes are walked for the same reason the plain ones are: real modules use them.
 * Unity's player leans on 0xFD vectors, and 0xFE atomic loads and stores are valid on an unshared
 * memory too. Shared memories themselves are refused (see `skipLimits`), so Emscripten's `-pthread`
 * output, which imports one, is not supported. The atomic loads and stores and the vector memory
 * accesses carry the same memarg as `i32.load`, so they are probed exactly like it. The rest of
 * the atomic space is refused, because its immediates are not decoded here; the rest of the vector
 * space is copied through after its immediates are skipped, since only memory accesses need a probe.
 *
 * One vector form cannot be probed at all. `v128.load*_lane` takes its address *under* a vector
 * operand — `[address, v128] -> [v128]` — so the address is not on top of the stack where a
 * `(i32)->(i32)` probe needs it, and moving the vector out of the way would take a new local and a
 * re-encoding of the body's locals. Those four subopcodes are walked and then reported through
 * `InstrumentedModule.unprobed`, so a host can say which read it is not seeing instead of claiming
 * a complete trace.
 *
 * While the flag is 0 the cost is one `global.get`/branch per store and one call per load, and
 * no JavaScript ever runs.
 *
 * Patching is the same rewrite pointed the other way: instead of observing a function, throw it
 * away. A patch replaces one body with `const <value>; end`, so a host can neutralise a progress
 * check or a scoring routine while the rest of the module keeps running. Patches are resolved and
 * encoded in the same pass as the instrumentation, because both edit the code section and two
 * passes over one module would have to renumber indices for each other. A patched body is not
 * instrumented: the callbacks and probes it used to contain left with the body, so nothing inside
 * it can be reported and nothing inside it counts as a store or a read.
 *
 * Adding the callback imports moves every defined function up in the function index space, by
 * as many slots as imports were added, so the rewriter repairs every place a function index is
 * encoded: function exports, `call`, `ref.func`, the start section and element segments. The
 * index reported at runtime is therefore an index of the *instrumented* module; a host turns it
 * into a name by reading that module's export section.
 */

import { BridgeError } from '@wasmcheat/protocol';

/** Name the instrumented module imports its callbacks from. */
const CALLBACK_MODULE = '__wasmcheat';

/** Field the instrumented module imports its store callback as. */
const CALLBACK_FIELD = 'on_store';

/** Field the instrumented module imports its load callback as. */
const READ_FIELD = 'on_read';

/** Export the host calls to arm and disarm the callbacks. */
const ARM_EXPORT = '__wc_arm';

/** `i32` value type, the only type the callbacks and the probes deal in. */
const I32 = 0x7f;

/**
 * The immediates one 0xFD (SIMD) subopcode carries, and whether it touches memory. A vector
 * instruction is the 0xFD prefix, a LEB128 subopcode, then whatever that subopcode's layout says;
 * the walk has to know every layout to stay in step with the instruction stream.
 *
 * The assignments below are the WebAssembly 2.0 core specification, binary format appendix,
 * "Vector Instructions" (subopcodes 0x00-0xFF). The 0x100-0x113 block is the relaxed-SIMD proposal
 * (merged into the in-progress 3.0 draft), whose subopcodes take no immediates either. A subopcode
 * that no range below covers is unassigned in the specification, so the rewriter refuses the
 * module rather than guess how many bytes follow it.
 *
 * - `none`: no immediates, no memory access.
 * - `lane`: one lane-index byte, no memory access (`i8x16.extract_lane_s` and friends).
 * - `bytes16`: sixteen immediate bytes (`v128.const`, `i8x16.shuffle`).
 * - `load` / `store`: a memarg, reading or writing memory.
 * - `lane-load` / `lane-store`: a memarg then a lane-index byte, reading or writing one lane.
 */
type SimdLayout = 'none' | 'lane' | 'bytes16' | 'load' | 'store' | 'lane-load' | 'lane-store';

interface SimdLayoutRange {
  /** First subopcode of the range. */
  first: number;
  /** Last subopcode of the range, inclusive. */
  last: number;
  layout: SimdLayout;
}

/** Every assigned 0xFD subopcode as a range; the gaps are the subopcodes the specification leaves open. */
const SIMD_LAYOUT_RANGES: readonly SimdLayoutRange[] = [
  { first: 0x00, last: 0x0a, layout: 'load' }, // v128.load, load8x8/16x4/32x2 _s/_u, load*_splat
  { first: 0x0b, last: 0x0b, layout: 'store' }, // v128.store
  { first: 0x0c, last: 0x0d, layout: 'bytes16' }, // v128.const, i8x16.shuffle
  { first: 0x0e, last: 0x14, layout: 'none' }, // i8x16.swizzle and the six splats
  { first: 0x15, last: 0x22, layout: 'lane' }, // extract_lane and replace_lane of every shape
  { first: 0x23, last: 0x53, layout: 'none' }, // comparisons, v128 bitwise ops, v128.any_true
  { first: 0x54, last: 0x57, layout: 'lane-load' }, // v128.load8/16/32/64_lane
  { first: 0x58, last: 0x5b, layout: 'lane-store' }, // v128.store8/16/32/64_lane
  { first: 0x5c, last: 0x5d, layout: 'load' }, // v128.load32_zero, v128.load64_zero
  { first: 0x5e, last: 0x99, layout: 'none' }, // conversions, then lane-wise integer arithmetic
  { first: 0x9b, last: 0xa1, layout: 'none' }, // 0x9a is unassigned
  { first: 0xa3, last: 0xa4, layout: 'none' }, // 0xa2 is unassigned
  { first: 0xa7, last: 0xae, layout: 'none' }, // 0xa5 and 0xa6 are unassigned
  { first: 0xb1, last: 0xb1, layout: 'none' }, // 0xaf and 0xb0 are unassigned
  { first: 0xb5, last: 0xba, layout: 'none' }, // 0xb2-0xb4 are unassigned
  { first: 0xbc, last: 0xc1, layout: 'none' }, // 0xbb is unassigned
  { first: 0xc3, last: 0xc4, layout: 'none' }, // 0xc2 is unassigned
  { first: 0xc7, last: 0xce, layout: 'none' }, // 0xc5 and 0xc6 are unassigned
  { first: 0xd1, last: 0xd1, layout: 'none' }, // 0xcf and 0xd0 are unassigned
  { first: 0xd5, last: 0xe1, layout: 'none' }, // 0xd2-0xd4 are unassigned
  { first: 0xe3, last: 0xed, layout: 'none' }, // 0xe2 is unassigned
  { first: 0xef, last: 0x113, layout: 'none' }, // 0xee is unassigned; 0x100-0x113 are relaxed SIMD
];

/** Subopcode to layout. The ranges are flattened once, so the walk is a lookup per opcode. */
const SIMD_LAYOUTS: ReadonlyMap<number, SimdLayout> = new Map(
  SIMD_LAYOUT_RANGES.flatMap(({ first, last, layout }) =>
    Array.from({ length: last - first + 1 }, (_, index): [number, SimdLayout] => [first + index, layout]),
  ),
);

/**
 * Why the lane loads in `SIMD_LAYOUTS` are walked without a probe, reported to callers through
 * `InstrumentedModule.unprobed`.
 */
const LANE_LOAD_UNPROBED_REASON =
  'address is below the vector operand, so a stack-neutral probe is not possible without a new local';

/** The remaining numeric value types a stub can return a constant of. */
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;

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

const UTF8_DECODE = new TextDecoder();

const IDENTITY = (index: number): number => index;

export interface InstrumentedModule {
  /** Rewritten module, ready for `new WebAssembly.Module` or `WebAssembly.instantiate`. */
  bytes: Uint8Array<ArrayBuffer>;
  importModule: '__wasmcheat';
  /**
   * Store callback field. Always reported, so callers written before reads existed keep working;
   * the module only imports it while `writes` is on.
   */
  importField: 'on_store';
  armExport: '__wc_arm';
  /** Injected call sites: every store instruction plus the bulk-memory writes. */
  storeCount: number;
  /** Load instructions that were wrapped by a probe call; lane loads are not among them. */
  readCount: number;
  /** Probe functions appended, one per defined function that reads memory. */
  probeCount: number;
  /** Defined functions in the input module, i.e. how many code bodies were rewritten. */
  functionCount: number;
  /**
   * Defined-function indices whose bodies were replaced by a patch, one entry per patch and in the
   * order the patches were given, so a caller that keeps its own list can zip the two. They are
   * indices of the *input* module's defined functions; the callback imports shift every index, so
   * the slot one of them occupies at runtime is this index plus the imports the rewrite added.
   */
  patchedFunctions: number[];
  /**
   * Memory accesses the rewriter walked but did not instrument, one entry per (function, subopcode)
   * pair. Empty when everything was covered, and empty with `reads: false`, which asked for no
   * probes in the first place. A caller that reports what is here tells a user what is *not*
   * traced, instead of leaving them to assume every access is.
   */
  unprobed: UnprobedAccess[];
}

/** A memory access the rewriter walked but could not instrument. */
export interface UnprobedAccess {
  /** 0xFD subopcode of the access, e.g. 0x54 for `v128.load8_lane`. */
  opcode: number;
  /**
   * Defined-function index of the *input* module that holds the access, numbered the way
   * `patchedFunctions` is. The callback imports shift every defined function, so this is not the
   * index the callbacks report at runtime.
   */
  functionIndex: number;
  /** Why no probe was emitted, in words a host can show a user. */
  reason: string;
}

/**
 * One function to replace with a constant-returning stub, in the same pass that instruments the
 * rest of the module.
 */
export interface FunctionPatch {
  /** Defined-function index (0 = first function after the imports), or — see `byName` — an export name. */
  function?: number;
  /** Export name of the function to stub. Takes precedence over `function` when given. */
  byName?: string;
  /** Only `stub` for now: the body becomes `const value; end` (i32/f32/f64/i64 per result type). */
  mode: 'stub' | 'empty';
  /** Constant to return. Default 0. Ignored by `empty`. */
  value?: number | bigint;
}

/** Which memory accesses to instrument. Both directions default to on. */
export interface InstrumentOptions {
  /** Wrap loads with a probe call. `false` leaves every load byte-for-byte untouched. */
  reads?: boolean;
  /** Append the guarded callback after every write. `false` leaves writes untouched. */
  writes?: boolean;
  /** Function bodies to replace before instrumentation, in any order. */
  patches?: FunctionPatch[];
}

/**
 * Rewrites `bytes` so every memory access reports the instrumented module's function index to
 * the `__wasmcheat.on_store` / `__wasmcheat.on_read` imports while `__wc_arm(1)` is in effect.
 *
 * Throws `BridgeError` with code `UNSUPPORTED`, naming the opcode or section, when the module
 * uses something this rewriter cannot decode; the input bytes are never partially rewritten.
 */
export function instrumentModule(bytes: Uint8Array, options: InstrumentOptions = {}): InstrumentedModule {
  const reads = options.reads ?? true;
  const writes = options.writes ?? true;
  const sections = parseSections(bytes);
  const layout = inspectModule(sections);
  // Every patch is resolved and encoded before any section is touched, so an unusable patch
  // rejects the whole rewrite instead of leaving half a module behind.
  const patches = resolvePatches(options.patches ?? [], layout, readFunctionExports(sections));

  const importedFunctionCount = layout.importedFunctionCount;
  // The callback imports are appended after the existing imports, so they take the first slots
  // the defined functions used to occupy. Every index shift uses this count, never a literal 1.
  const addedImports = (writes ? 1 : 0) + (reads ? 1 : 0);
  const shiftFunctionIndex = (index: number): number =>
    index >= importedFunctionCount ? index + addedImports : index;
  /** Index the defined function at `definedFunctionIndex` occupies once instrumented. */
  const definedFunctionSlot = (definedFunctionIndex: number): number =>
    importedFunctionCount + addedImports + definedFunctionIndex;

  // Appended type entries, in the order the callbacks and then the probe need them.
  const appendedTypes: FunctionType[] = [];
  const appendType = (params: number[], results: number[]): number => {
    const index = layout.types.length + appendedTypes.length;
    appendedTypes.push({ params: Uint8Array.from(params), results: Uint8Array.from(results) });
    return index;
  };
  const existingProbeType = layout.types.findIndex(
    (type) =>
      type.params.length === 1 && type.params[0] === I32 && type.results.length === 1 && type.results[0] === I32,
  );

  const storeCallbackTypeIndex = writes ? appendType([I32], []) : null;
  const readCallbackTypeIndex = reads ? appendType([I32, I32], []) : null;
  // `__wc_arm` takes and answers an i32 exactly like a probe, so both share one type entry.
  const probeTypeIndex = existingProbeType === -1 ? appendType([I32], [I32]) : existingProbeType;

  const storeCallbackIndex = writes ? importedFunctionCount : null;
  const readCallbackIndex = reads ? importedFunctionCount + (writes ? 1 : 0) : null;
  // Imported globals come first in the global index space, so the appended flag follows them too.
  const flagsGlobalIndex = layout.importedGlobalCount + layout.globalCount;
  const armFunctionIndex = definedFunctionSlot(layout.functionCount);

  const storeInjectionFor = (definedFunctionIndex: number): Uint8Array<ArrayBuffer> | null => {
    if (storeCallbackIndex === null) return null;
    return new Writer()
      .u8(0x23)
      .u32(flagsGlobalIndex) // global.get <flags>
      .u8(0x04)
      .u8(0x40) // if, no result
      .u8(0x41)
      .s32(definedFunctionSlot(definedFunctionIndex)) // i32.const <function>
      .u8(0x10)
      .u32(storeCallbackIndex) // call <on_store>
      .u8(0x0b) // end
      .toBytes();
  };

  const probes = ((): RewriteContext['probes'] => {
    if (readCallbackIndex === null) return null;
    const callbackIndex = readCallbackIndex;
    return {
      // `__wc_arm` sits between the original functions and the probes.
      firstIndex: armFunctionIndex + 1,
      bodyFor: (definedFunctionIndex, offset) => {
        const body = new Writer()
          .u32(0) // no local declarations
          .u8(0x23)
          .u32(flagsGlobalIndex) // global.get <flags>
          .u8(0x04)
          .u8(0x40) // if, no result
          .u8(0x20)
          .u8(0x00) // local.get 0: the address the load is about to use
        if (offset !== 0) {
          // The load's own offset immediate is part of the effective address; add it here so the
          // host is told the address that is actually touched, not the base operand.
          body.u8(0x41).s32(offset).u8(0x6a); // i32.const <offset>; i32.add
        }
        return body
          .u8(0x41)
          .s32(definedFunctionSlot(definedFunctionIndex)) // i32.const <function>
          .u8(0x10)
          .u32(callbackIndex) // call <on_read>
          .u8(0x0b) // end
          .u8(0x20)
          .u8(0x00) // local.get 0: hand the address back to the load
          .u8(0x0b) // end
          .toBytes();
      },
    };
  })();

  const context: RewriteContext = {
    shiftFunctionIndex,
    storeInjectionFor,
    probes,
    stubBodyFor: (definedFunctionIndex) => patches.bodies.get(definedFunctionIndex) ?? null,
    armBody: new Writer()
      .u32(0) // no local declarations
      .u8(0x20)
      .u8(0x00) // local.get 0
      .u8(0x24)
      .u32(flagsGlobalIndex) // global.set <flags>
      .u8(0x20)
      .u8(0x00) // local.get 0: the (i32)->(i32) type wants the flags back
      .u8(0x0b)
      .toBytes(),
  };

  const callbackImports: CallbackImport[] = [];
  if (storeCallbackTypeIndex !== null) {
    callbackImports.push({ field: CALLBACK_FIELD, typeIndex: storeCallbackTypeIndex });
  }
  if (readCallbackTypeIndex !== null) {
    callbackImports.push({ field: READ_FIELD, typeIndex: readCallbackTypeIndex });
  }

  // The code section is rewritten first: how many probes the bodies needed decides how many
  // function entries the function section has to declare, and that section comes earlier.
  const rewrittenCode = rewriteCodeSection(requireSection(sections, 10).payload, context);

  for (const section of sections) {
    switch (section.id) {
      case 1:
        section.payload = appendTypes(section.payload, appendedTypes);
        break;
      case 2:
        if (callbackImports.length > 0) section.payload = appendImports(section.payload, callbackImports);
        break;
      case 3:
        // `__wc_arm` and every probe are `(i32)->(i32)`, so they all share one type index.
        section.payload = appendGeneratedFunctions(section.payload, probeTypeIndex, 1 + rewrittenCode.probeCount);
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
      case 10:
        section.payload = rewrittenCode.payload;
        break;
      case 0:
        section.payload = shiftFunctionNames(section.payload, context);
        break;
      default:
        // Table, memory, data count and data sections carry no function indices.
        break;
    }
  }

  if (callbackImports.length > 0 && !sections.some((section) => section.id === 2)) {
    insertSection(sections, { id: 2, payload: appendImports(null, callbackImports) });
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
    storeCount: rewrittenCode.storeCount,
    readCount: rewrittenCode.readCount,
    probeCount: rewrittenCode.probeCount,
    functionCount: layout.functionCount,
    patchedFunctions: patches.order,
    unprobed: rewrittenCode.unprobed,
  };
}

interface Section {
  id: number;
  payload: Uint8Array;
}

/** One function-type entry, kept so a probe can reuse an existing signature instead of adding one. */
interface FunctionType {
  params: Uint8Array;
  results: Uint8Array;
}

/** One import entry to append, in callback order. */
interface CallbackImport {
  field: string;
  typeIndex: number;
}

interface ModuleLayout {
  types: FunctionType[];
  /** Type index of each defined function, in function-section order. */
  functionTypeIndices: number[];
  importedFunctionCount: number;
  functionCount: number;
  importedGlobalCount: number;
  globalCount: number;
}

interface RewriteContext {
  /** Maps a function index of the input module to its index once the callback imports are added. */
  shiftFunctionIndex(index: number): number;
  /** Guard + callback bytes appended after every write in the given defined function. */
  storeInjectionFor(definedFunctionIndex: number): Uint8Array<ArrayBuffer> | null;
  /** Replacement body of a stubbed function, or null when the original body must be rewritten. */
  stubBodyFor(definedFunctionIndex: number): Uint8Array<ArrayBuffer> | null;
  /** Everything needed to wrap loads, or null when reads are off and loads must stay untouched. */
  probes: {
    /** Instrumented-module index the first probe occupies; the probes follow one another. */
    firstIndex: number;
    /** Body of the probe of one (defined function, memory offset) pair, both baked in. */
    bodyFor(definedFunctionIndex: number, offset: number): Uint8Array<ArrayBuffer>;
  } | null;
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

  /** Signed LEB128, the encoding `i64.const` expects. */
  s64(value: bigint): this {
    let remaining = BigInt.asIntN(64, value);
    for (;;) {
      const byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      const signSet = (byte & 0x40) !== 0;
      if ((remaining === 0n && !signSet) || (remaining === -1n && signSet)) {
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
  readCount: number;
  /** 0xFD subopcodes of the reads left unprobed, in the order met, one entry per occurrence. */
  unprobed: number[];
}

interface SequenceOptions {
  /** Maps a function index of the input module to its index in the rewritten module. */
  shiftFunctionIndex(index: number): number;
  /** Guard + callback bytes appended after every write; null leaves stores untouched. */
  storeInjection: Uint8Array | null;
  /** Builds the `call <probe>` bytes emitted before every load; null leaves loads untouched. */
  probeCall: ((offset: number) => Uint8Array<ArrayBuffer>) | null;
  /** Names where these instructions live in a rejected-opcode message, e.g. `function 3`. */
  site: string;
}

/**
 * Re-emits one instruction sequence (a function body's instructions or a constant expression),
 * shifting every function index, appending the guarded callback after every memory write and
 * preceding every load with a probe call.
 */
function rewriteInstructionSequence(
  source: Uint8Array,
  start: number,
  options: SequenceOptions,
): SequenceRewrite {
  const reader = new Reader(source, start);
  const out = new Writer();
  let depth = 0;
  let storeCount = 0;
  let readCount = 0;
  const unprobed: number[] = [];
  let terminated = false;

  while (!terminated) {
    if (reader.atEnd) throw unsupported('instruction sequence ends without its final `end`');
    const instructionStart = reader.offset;
    const opcode = reader.u8();
    let shiftedIndex: number | null = null;
    let memoryOffset: number | null = null;
    // 0x28-0x35 are the i32/i64/f32/f64 loads, 0x36-0x3e the stores; the 0xFC, 0xFD and 0xFE
    // cases below add the bulk-memory, vector and atomic accesses.
    let loads = opcode >= 0x28 && opcode <= 0x35;
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
        // Block type: 0x40, a value type, or an s33 type index. Read as a value type first, so a
        // typed reference result is refused; a set high bit means the rest of a type index follows.
        if ((valueType(reader, options.site) & 0x80) !== 0) reader.skipLeb(4);
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
        for (let index = 0; index < types; index += 1) valueType(reader, options.site);
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
      case 0xd0: // ref.null <heap type>: an s33, one byte for the abstract types, more for a type index
        reader.skipLeb(5);
        break;
      case 0xfc: {
        // Bulk memory and table operations, prefixed. The bulk writes (memory.init/copy/fill)
        // are deliberately never wrapped as reads: they take their length on top of the stack,
        // so a `(i32)->(i32)` probe would receive the length, not an address. Wrapping them
        // would need the stack analysis this rewriter exists to avoid.
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
      case 0xfd: {
        // Vector instructions: the prefix, a LEB128 subopcode, then that subopcode's immediates.
        // The memory accesses take the probe path; everything else is re-emitted after its
        // immediates are skipped, which is what keeps the walk in step with the stream.
        const subopcode = reader.u32();
        const layout = SIMD_LAYOUTS.get(subopcode);
        if (layout === undefined) {
          throw unsupported(
            `0xFD subopcode 0x${subopcode.toString(16)} in ${options.site} is not one this rewriter can decode`,
          );
        }
        switch (layout) {
          case 'none':
            break;
          case 'lane':
            reader.u8(); // lane index
            break;
          case 'bytes16':
            reader.skip(16); // `v128.const` payload, or the sixteen lane indices of `i8x16.shuffle`
            break;
          case 'load':
          case 'store':
          case 'lane-load':
          case 'lane-store': {
            const offset = readMemargOffset(reader, options.site);
            // The lane forms carry a lane index after the memarg whether or not they are probed.
            if (layout === 'lane-load' || layout === 'lane-store') reader.u8();
            if (layout === 'load') {
              loads = true;
              memoryOffset = offset;
            } else if (layout === 'lane-load') {
              // `[address, v128] -> [v128]`: the vector is on top of the stack, so the probe would
              // read the vector as the address. Reaching the address would take a local holding
              // the vector, and a body's locals are copied through untouched, so the access is
              // walked and reported instead of probed. See `LANE_LOAD_UNPROBED_REASON`.
              if (options.probeCall !== null) unprobed.push(subopcode);
            } else {
              // `v128.store` and the lane stores consume their operands, so the stack is empty
              // again once the instruction has run: the callback can be appended after it.
              writes = true;
            }
            break;
          }
        }
        break;
      }
      case 0xfe: {
        // Atomic (threads) instructions: the prefix, a LEB128 subopcode, then a memarg exactly like
        // the non-atomic form. Per the threads proposal's opcode table, 0x10-0x16 are the loads
        // (i32.atomic.load, i64.atomic.load, i32.atomic.load8_u, i32.atomic.load16_u,
        // i64.atomic.load8/16/32_u) and 0x17-0x1D the stores in the same widths, so the two ranges
        // are all this rewriter needs. The read-modify-write, notify and fence forms are refused
        // rather than re-emitted, so a module whose atomics this rewriter cannot account for fails
        // loudly instead of being half-instrumented.
        const subopcode = reader.u32();
        if (subopcode >= 0x10 && subopcode <= 0x16) {
          memoryOffset = readMemargOffset(reader, options.site);
          loads = true;
        } else if (subopcode >= 0x17 && subopcode <= 0x1d) {
          readMemargOffset(reader, options.site);
          writes = true;
        } else {
          throw unsupported(
            `0xFE subopcode 0x${subopcode.toString(16)} in ${options.site} is not an atomic load or store this rewriter instruments`,
          );
        }
        break;
      }
      default:
        if (opcode >= 0x28 && opcode <= 0x3e) {
          // Loads and stores: alignment then offset. The offset is part of the effective
          // address, and compilers emit `i32.const 0; i32.load offset=N` for globals, so a probe
          // that only saw the base operand would report 0 for every static address.
          const offset = readMemargOffset(reader, options.site);
          if (opcode <= 0x35) memoryOffset = offset;
          break;
        }
        if (opcode >= 0x45 && opcode <= 0xc4) break; // numeric instructions, no immediates
        throw unsupported(`unknown opcode 0x${opcode.toString(16)}`);
    }

    if (loads && options.probeCall !== null) {
      // The address is on top of the stack already; the probe reports it and hands it back, so
      // the untouched load that follows consumes exactly what it would have consumed alone.
      out.bytes(options.probeCall(memoryOffset ?? 0));
      readCount += 1;
    }
    if (shiftedIndex === null) {
      out.bytes(source.subarray(instructionStart, reader.offset));
    } else {
      out.u8(opcode).u32(options.shiftFunctionIndex(shiftedIndex));
    }
    if (writes && options.storeInjection !== null) {
      out.bytes(options.storeInjection);
      storeCount += 1;
    }
  }

  return { bytes: out.toBytes(), end: reader.offset, storeCount, readCount, unprobed };
}

/**
 * Reads one value type. Every value type is one byte except the typed references
 * `(ref null <heap type>)` (0x63) and `(ref <heap type>)` (0x64), which carry an s33 heap type
 * after the prefix; reading those as one byte would leave the heap type behind to be decoded as
 * whatever comes next, so they are refused wherever a value type is read.
 */
function valueType(reader: Reader, site: string): number {
  const type = reader.u8();
  if (type === 0x63 || type === 0x64) {
    throw unsupported(
      `${site} uses a typed reference value type (0x${type.toString(16)}), which this rewriter cannot decode`,
    );
  }
  return type;
}

/**
 * Reads a memarg and returns its offset. Bit 6 of the alignment field (the multi-memory encoding)
 * means a memory index precedes the offset; only memory 0 exists here, so an explicit 0 is kept as
 * it was and any other index is refused.
 */
function readMemargOffset(reader: Reader, site: string): number {
  const alignment = reader.u32();
  if ((alignment & 0x40) !== 0) {
    const memory = reader.u32();
    if (memory !== 0) throw unsupported(`${site} accesses memory ${memory}, only memory 0 is supported`);
  }
  return reader.u32();
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
  const types = readTypes(requireSection(sections, 1).payload);
  const importSection = sections.find((section) => section.id === 2);
  const imports =
    importSection === undefined
      ? { functionCount: 0, memoryCount: 0, globalCount: 0 }
      : inspectImports(importSection.payload);
  const memorySection = sections.find((section) => section.id === 5);
  const declaredMemoryCount = memorySection === undefined ? 0 : countMemories(memorySection.payload);
  if (imports.memoryCount + declaredMemoryCount > 1) throw unsupported('multiple memories are not supported');
  const functionTypeIndices = readFunctionTypeIndices(requireSection(sections, 3).payload);
  const functionCount = functionTypeIndices.length;
  const bodyCount = new Reader(requireSection(sections, 10).payload).u32();
  if (bodyCount !== functionCount) {
    throw unsupported(`code section holds ${bodyCount} bodies but the function section declares ${functionCount}`);
  }
  const globalSection = sections.find((section) => section.id === 6);
  return {
    types,
    functionTypeIndices,
    importedFunctionCount: imports.functionCount,
    functionCount,
    importedGlobalCount: imports.globalCount,
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

function readTypes(payload: Uint8Array): FunctionType[] {
  const reader = new Reader(payload);
  const count = reader.u32();
  const types: FunctionType[] = [];
  for (let index = 0; index < count; index += 1) {
    const form = reader.u8();
    if (form !== 0x60) {
      throw unsupported(`type ${index} uses type form 0x${form.toString(16)}, only function types are supported`);
    }
    // Parameter then result value types, one byte each once typed references are refused.
    const readValueTypes = (): Uint8Array =>
      Uint8Array.from({ length: reader.u32() }, () => valueType(reader, `type ${index}`));
    const params = readValueTypes();
    const results = readValueTypes();
    types.push({ params, results });
  }
  return types;
}

function inspectImports(payload: Uint8Array): { functionCount: number; memoryCount: number; globalCount: number } {
  const reader = new Reader(payload);
  const count = reader.u32();
  let functionCount = 0;
  let memoryCount = 0;
  let globalCount = 0;
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
        valueType(reader, `import ${index}`);
        skipLimits(reader, 'table');
        break;
      case 0x02: // memory: limits
        skipLimits(reader, 'memory');
        memoryCount += 1;
        break;
      case 0x03: // global: value type then mutability
        valueType(reader, `import ${index}`);
        reader.u8();
        globalCount += 1;
        break;
      case 0x04: // tag: attribute then type index
        reader.u8();
        reader.u32();
        break;
      default:
        throw unsupported(`import ${index} has unknown kind 0x${kind.toString(16)}`);
    }
  }
  return { functionCount, memoryCount, globalCount };
}

/** Memory and table imports share the limits encoding; `kind` names which one a refusal is about. */
function skipLimits(reader: Reader, kind: 'memory' | 'table'): void {
  const flags = reader.u8();
  if ((flags & 0x02) !== 0) throw unsupported(`a shared ${kind} is not supported`);
  if ((flags & 0x04) !== 0) throw unsupported(`a 64-bit ${kind} is not supported`);
  reader.u32(); // minimum
  if ((flags & 0x01) !== 0) reader.u32(); // maximum
}

function countMemories(payload: Uint8Array): number {
  const reader = new Reader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) skipLimits(reader, 'memory');
  return count;
}

/** The type index of every defined function, which is how a function's signature is found. */
function readFunctionTypeIndices(payload: Uint8Array): number[] {
  const reader = new Reader(payload);
  const count = reader.u32();
  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) indices.push(reader.u32());
  return indices;
}

/**
 * Function exports by name, as function indices of the input module. Table, memory and global
 * exports share the section but not the index space the patches address, so they are ignored.
 */
function readFunctionExports(sections: Section[]): Map<string, number> {
  const names = new Map<string, number>();
  const section = sections.find((candidate) => candidate.id === 7);
  if (section === undefined) return names;
  const reader = new Reader(section.payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    const name = UTF8_DECODE.decode(reader.bytes(reader.u32()));
    const kind = reader.u8();
    const target = reader.u32();
    if (kind === 0x00) names.set(name, target);
  }
  return names;
}

/** The bodies a rewrite substitutes, plus the patch order the caller expects back. */
interface PatchResolution {
  /** Replacement body per defined-function index. */
  bodies: Map<number, Uint8Array<ArrayBuffer>>;
  /** Defined-function index of each patch, in the order the patches were given. */
  order: number[];
}

/**
 * Turns the caller's patches into replacement bodies, keyed by defined-function index. An empty
 * patch list produces an empty resolution, so an unpatched module is untouched.
 */
function resolvePatches(
  patches: FunctionPatch[],
  layout: ModuleLayout,
  functionExports: Map<string, number>,
): PatchResolution {
  const bodies = new Map<number, Uint8Array<ArrayBuffer>>();
  const order: number[] = [];
  for (const patch of patches) {
    const { definedFunctionIndex, label } = resolvePatchTarget(patch, layout, functionExports);
    bodies.set(definedFunctionIndex, patchBody(patch, layout, definedFunctionIndex, label));
    order.push(definedFunctionIndex);
  }
  return { bodies, order };
}

/** The defined function a patch names, and a label naming it the way its error messages do. */
function resolvePatchTarget(
  patch: FunctionPatch,
  layout: ModuleLayout,
  functionExports: Map<string, number>,
): { definedFunctionIndex: number; label: string } {
  if (patch.byName !== undefined) {
    const name = patch.byName;
    const exported = functionExports.get(name);
    if (exported === undefined) throw unsupported(`no function is exported as "${name}", so it cannot be patched`);
    // Exports address the whole function index space, imports included, while patches address
    // defined functions — the ones that have a body.
    const definedFunctionIndex = exported - layout.importedFunctionCount;
    if (definedFunctionIndex < 0 || definedFunctionIndex >= layout.functionCount) {
      throw unsupported(`the export "${name}" is an import of this module, so it has no body to patch`);
    }
    return { definedFunctionIndex, label: `the export "${name}"` };
  }
  const definedFunctionIndex = patch.function;
  if (definedFunctionIndex === undefined) {
    throw unsupported('a patch needs either `function` or `byName` to say what to patch');
  }
  if (
    !Number.isInteger(definedFunctionIndex) ||
    definedFunctionIndex < 0 ||
    definedFunctionIndex >= layout.functionCount
  ) {
    throw unsupported(
      `function ${definedFunctionIndex} does not exist: the module defines ${layout.functionCount} functions`,
    );
  }
  return { definedFunctionIndex, label: `function ${definedFunctionIndex}` };
}

/**
 * The complete body that replaces the patched function: locals first, then the constant the
 * function's result type wants, then `end`. The body keeps the function's own type entry, so nothing
 * else in the module has to move.
 */
function patchBody(
  patch: FunctionPatch,
  layout: ModuleLayout,
  definedFunctionIndex: number,
  label: string,
): Uint8Array<ArrayBuffer> {
  const typeIndex = layout.functionTypeIndices[definedFunctionIndex];
  const type = typeIndex === undefined ? undefined : layout.types[typeIndex];
  if (type === undefined) {
    throw unsupported(`${label} has type index ${String(typeIndex)}, which the type section does not declare`);
  }

  if (patch.mode === 'empty') {
    if (type.results.length !== 0) {
      throw unsupported(`${label} returns a result, so an empty body is unsupported; use mode "stub"`);
    }
    return new Writer().u32(0).u8(0x0b).toBytes();
  }
  if (patch.mode !== 'stub') {
    throw unsupported(`${label} asked for patch mode "${String(patch.mode)}", which is unsupported`);
  }

  if (type.results.length > 1) {
    throw unsupported(`${label} returns ${type.results.length} results, which one constant cannot produce`);
  }
  const [result] = type.results;
  if (result === undefined) {
    throw unsupported(`${label} returns no results, so a constant stub is unsupported; use mode "empty"`);
  }

  const body = new Writer().u32(0); // no locals: a constant needs none
  switch (result) {
    case I32:
      body.u8(0x41).s32(constantAsNumber(patch.value)); // i32.const
      break;
    case I64:
      body.u8(0x42).s64(constantAsI64(patch.value)); // i64.const
      break;
    case F32:
      body.u8(0x43).bytes(floatBytes(4, constantAsNumber(patch.value))); // f32.const
      break;
    case F64:
      body.u8(0x44).bytes(floatBytes(8, constantAsNumber(patch.value))); // f64.const
      break;
    default:
      throw unsupported(
        `${label} returns value type 0x${result.toString(16)}, which a constant stub cannot produce`,
      );
  }
  return body.u8(0x0b).toBytes();
}

/** The patch constant as a number, for the integer and float bodies that take one. */
function constantAsNumber(value: number | bigint | undefined): number {
  if (value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** The patch constant as an i64. A fractional number is truncated, as `i64.const` cannot hold it. */
function constantAsI64(value: number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (!Number.isFinite(value)) throw unsupported(`an i64 stub cannot return ${value}: it is not a finite number`);
  return BigInt(Math.trunc(value));
}

/** Little-endian IEEE-754 payload of an `f32.const` or `f64.const`. */
function floatBytes(width: 4 | 8, value: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(width);
  const view = new DataView(buffer);
  if (width === 4) view.setFloat32(0, value, true);
  else view.setFloat64(0, value, true);
  return new Uint8Array(buffer);
}

function countGlobals(payload: Uint8Array): number {
  const reader = new Reader(payload);
  const count = reader.u32();
  for (let index = 0; index < count; index += 1) {
    valueType(reader, `global ${index}`);
    reader.u8(); // mutability
    const expression = rewriteInstructionSequence(payload, reader.offset, {
      shiftFunctionIndex: IDENTITY,
      storeInjection: null,
      probeCall: null,
      site: `the initializer of global ${index}`,
    });
    reader.seek(expression.end);
  }
  return count;
}

function appendTypes(payload: Uint8Array, appended: FunctionType[]): Uint8Array<ArrayBuffer> {
  const reader = new Reader(payload);
  const count = reader.u32();
  const types = new Writer().u32(count + appended.length).bytes(payload.subarray(reader.offset));
  for (const type of appended) {
    types.u8(0x60).u32(type.params.length).bytes(type.params).u32(type.results.length).bytes(type.results);
  }
  return types.toBytes();
}

/**
 * Appends the callback imports in the order the caller built them, so the first one takes the
 * lowest free function index — the order the caller's index arithmetic assumes.
 */
function appendImports(payload: Uint8Array | null, entries: CallbackImport[]): Uint8Array<ArrayBuffer> {
  const imports = new Writer();
  if (payload === null) {
    imports.u32(entries.length);
  } else {
    const reader = new Reader(payload);
    imports.u32(reader.u32() + entries.length).bytes(payload.subarray(reader.offset));
  }
  for (const entry of entries) imports.name(CALLBACK_MODULE).name(entry.field).u8(0x00).u32(entry.typeIndex);
  return imports.toBytes();
}

function appendGeneratedFunctions(payload: Uint8Array, typeIndex: number, added: number): Uint8Array<ArrayBuffer> {
  const reader = new Reader(payload);
  const count = reader.u32();
  const functions = new Writer().u32(count + added).bytes(payload.subarray(reader.offset));
  for (let index = 0; index < added; index += 1) functions.u32(typeIndex);
  return functions.toBytes();
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
      const type = valueType(reader, `global ${index}`);
      const mutability = reader.u8();
      const expression = rewriteInstructionSequence(payload, reader.offset, {
        shiftFunctionIndex: context.shiftFunctionIndex,
        storeInjection: null,
        probeCall: null,
        site: `the initializer of global ${index}`,
      });
      globals.u8(type).u8(mutability).bytes(expression.bytes);
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
      if (UTF8_DECODE.decode(name) === ARM_EXPORT) {
        // A second `__wc_arm` would be a duplicate export the engine rejects, and the flag of the
        // first rewrite would still guard the old call sites.
        throw unsupported(`the module already exports "${ARM_EXPORT}", so it is already instrumented`);
      }
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

/**
 * Keeps the `name` custom section true to the shifted function index space. The function-names
 * subsection (id 1) is renumbered; the local and label names (ids 2 and 3) are keyed by function
 * index too and are dropped rather than renumbered; every other subsection names an index space
 * this rewriter only appends to, so it is copied as it was. Other custom sections are untouched.
 * Engines ignore a malformed name section, so one that does not parse loses its subsections
 * instead of rejecting the module.
 */
function shiftFunctionNames(payload: Uint8Array, context: RewriteContext): Uint8Array {
  const reader = new Reader(payload);
  const nameLength = reader.u32();
  if (UTF8_DECODE.decode(reader.bytes(nameLength)) !== 'name') return payload;
  const header = payload.subarray(0, reader.offset);
  const names = new Writer().bytes(header);
  try {
    while (!reader.atEnd) {
      const id = reader.u8();
      const content = reader.bytes(reader.u32());
      if (id === 2 || id === 3) continue;
      if (id !== 1) {
        names.u8(id).u32(content.length).bytes(content);
        continue;
      }
      const functions = new Reader(content);
      const count = functions.u32();
      const shifted = new Writer().u32(count);
      for (let index = 0; index < count; index += 1) {
        shifted.u32(context.shiftFunctionIndex(functions.u32()));
        const length = functions.u32();
        shifted.u32(length).bytes(functions.bytes(length));
      }
      const bytes = shifted.toBytes();
      names.u8(id).u32(bytes.length).bytes(bytes);
    }
  } catch {
    return header;
  }
  return names.toBytes();
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
      storeInjection: null,
      probeCall: null,
      site: 'an element segment expression',
    });
    elements.bytes(expression.bytes);
    reader.seek(expression.end);
  };
  const copyByte = (): void => {
    elements.u8(reader.u8());
  };
  const copyReferenceType = (): void => {
    elements.u8(valueType(reader, 'an element segment'));
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
        copyReferenceType();
        copyExpressions();
        break;
      case 6: // active, explicit table index, reference type then expressions
        copyIndex();
        copyExpression();
        copyReferenceType();
        copyExpressions();
        break;
      case 7: // declarative, reference type then expressions
        copyReferenceType();
        copyExpressions();
        break;
      default:
        throw unsupported(`element segment ${index} uses flags ${flags}, which this rewriter cannot decode`);
    }
  }
  if (!reader.atEnd) throw unsupported('element section holds trailing bytes');
  return elements.toBytes();
}

/** What one pass over the code section produced, plus the accesses it could not instrument. */
interface CodeRewrite {
  payload: Uint8Array<ArrayBuffer>;
  storeCount: number;
  readCount: number;
  probeCount: number;
  /** One entry per (function, subopcode) pair the pass walked without instrumenting. */
  unprobed: UnprobedAccess[];
}

function rewriteCodeSection(payload: Uint8Array, context: RewriteContext): CodeRewrite {
  const reader = new Reader(payload);
  const count = reader.u32();
  const bodies: Uint8Array<ArrayBuffer>[] = [];
  // A probe is allocated on the first load a body contains, which is why a body without loads
  // costs nothing. One probe covers one (function, memory offset) pair.
  const probeIndices = new Map<string, number>();
  const unprobed: UnprobedAccess[] = [];
  const unprobedSeen = new Set<string>();
  let storeCount = 0;
  let readCount = 0;

  for (let definedFunctionIndex = 0; definedFunctionIndex < count; definedFunctionIndex += 1) {
    const bodySize = reader.u32();
    const bodyStart = reader.offset;
    const bodyEnd = bodyStart + bodySize;
    if (bodyEnd > payload.length) {
      throw unsupported(`code body ${definedFunctionIndex} runs past the end of the code section`);
    }
    const body = payload.subarray(bodyStart, bodyEnd);
    // A patched body is not instrumented: its stores and loads left with the original body, so it
    // contributes no callback, no probe and no count.
    const stub = context.stubBodyFor(definedFunctionIndex);
    if (stub !== null) {
      bodies.push(stub);
      reader.seek(bodyEnd);
      continue;
    }
    const locals = new Reader(body);
    const localGroups = locals.u32();
    for (let group = 0; group < localGroups; group += 1) {
      locals.u32(); // how many locals this group declares
      valueType(locals, `the locals of function ${definedFunctionIndex}`);
    }
    const localsEnd = bodyStart + locals.offset;
    const probes = context.probes;
    const sequence = rewriteInstructionSequence(payload, localsEnd, {
      shiftFunctionIndex: context.shiftFunctionIndex,
      storeInjection: context.storeInjectionFor(definedFunctionIndex),
      probeCall:
        probes === null
          ? null
          : (offset) => {
              // The offset is baked into the probe (it is part of the effective address), so a
              // function that reads through several offsets needs one probe per offset.
              const key = `${definedFunctionIndex}:${offset}`;
              let probeIndex = probeIndices.get(key);
              if (probeIndex === undefined) {
                probeIndex = probes.firstIndex + probeIndices.size;
                probeIndices.set(key, probeIndex);
              }
              return new Writer().u8(0x10).u32(probeIndex).toBytes(); // call <probe>
            },
      site: `function ${definedFunctionIndex}`,
    });
    if (sequence.end !== bodyEnd) {
      throw unsupported(`code body ${definedFunctionIndex} does not end where its declared size says it does`);
    }
    bodies.push(
      new Writer().bytes(payload.subarray(bodyStart, localsEnd)).bytes(sequence.bytes).toBytes(),
    );
    storeCount += sequence.storeCount;
    readCount += sequence.readCount;
    for (const opcode of sequence.unprobed) {
      // One entry per (function, subopcode): a body with several lane loads of the same form has
      // the same gap, and repeating it per access would say nothing new.
      const key = `${definedFunctionIndex}:${opcode}`;
      if (unprobedSeen.has(key)) continue;
      unprobedSeen.add(key);
      unprobed.push({ opcode, functionIndex: definedFunctionIndex, reason: LANE_LOAD_UNPROBED_REASON });
    }
    reader.seek(bodyEnd);
  }

  // `__wc_arm` and the probes are generated here, never re-read from the input, so the rewriter
  // can never instrument its own instrumentation.
  const probeBodies: Uint8Array<ArrayBuffer>[] = [];
  const probes = context.probes;
  if (probes !== null) {
    for (const key of probeIndices.keys()) {
      const [definedFunctionIndex, offset] = key.split(':');
      probeBodies.push(probes.bodyFor(Number(definedFunctionIndex), Number(offset)));
    }
  }

  const code = new Writer().u32(bodies.length + 1 + probeBodies.length);
  for (const body of bodies) code.u32(body.length).bytes(body);
  code.u32(context.armBody.length).bytes(context.armBody);
  for (const body of probeBodies) code.u32(body.length).bytes(body);
  return { payload: code.toBytes(), storeCount, readCount, probeCount: probeBodies.length, unprobed };
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
