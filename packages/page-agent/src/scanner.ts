import {
  BridgeError,
  type ScanHit,
  type ScanMode,
  type ScanOptions,
  type ScanSummary,
  type SavedScanData,
  type TextScanOptions,
  type TextScanResult,
  type ValueType,
  VALUE_TYPE_BYTES,
} from '@wasmcheat/protocol';
import { MemoryAccess, defaultTolerance, viewReader, type TypedArrayLike } from './memory.js';

export interface ScanSession {
  id: string;
  instanceId: string;
  type: ValueType;
  mode: ScanMode;
  addresses: Uint32Array;
  /** Value observed at the same index of `addresses` at the end of the last pass. */
  values: Float64Array;
  count: number;
  truncated: boolean;
  memoryByteLength: number;
  passes: number;
  /** Set when memory grew since the previous pass, so zero-filled bytes are new candidates. */
  grewDuringLastPass?: boolean;
  /**
   * An unknown-value scan: every aligned position in the range is a candidate, too many to list,
   * so they are a bitmap and the previous values are a copy of the bytes. `addresses` stays empty
   * until a narrowing pass leaves few enough to list.
   */
  snapshot?: { start: number; end: number; alignment: number; bytes: Uint8Array; bits: Uint8Array };
  createdAt: number;
}

const DEFAULT_MAX_RESULTS = 250_000;
/** An unknown-value scan copies the memory it covers; past this, ask for a range instead. */
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
/** The movements a snapshot narrows by with a plain comparison, in the order the fast loop tests them. */
const MOVEMENT: ScanMode[] = ['changed', 'unchanged', 'increased', 'decreased'];
/** A snapshot scan becomes a plain address list once at most this many candidates are left. */
const SNAPSHOT_LIST_MAX = 1_000_000;

/** Modes that compare the current value against the value seen in the previous pass. */
const DELTA_MODES: ScanMode[] = ['changed', 'unchanged', 'increased', 'decreased', 'increased-by', 'decreased-by'];

export function isDeltaMode(mode: ScanMode): boolean {
  return DELTA_MODES.includes(mode);
}

/** Modes that need a target value from the caller. Delta modes never do. */
export function needsValue(mode: ScanMode): boolean {
  return !isDeltaMode(mode);
}

interface CompareOptions {
  value?: number;
  value2?: number;
  tolerance: number;
  isFloat: boolean;
  /**
   * Relative float error for increased-by/decreased-by when the caller set no tolerance: the
   * rounding in `current - previous` scales with the operands, not with the (small) delta.
   */
  relative?: number;
}

function matchesTarget(current: number, options: CompareOptions): boolean {
  return options.value === undefined || close(current, options.value, options);
}

function close(a: number, b: number, options: CompareOptions): boolean {
  return options.isFloat ? Math.abs(a - b) <= options.tolerance : a === b;
}

/**
 * One predicate for every comparison mode, so a first pass and a narrowing pass can never
 * disagree about what "greater than" means.
 */
export function satisfies(mode: ScanMode, current: number, previous: number | undefined, options: CompareOptions): boolean {
  const target = options.value;
  switch (mode) {
    case 'exact':
      return target === undefined ? true : close(current, target, options);
    case 'not-equal':
      return target === undefined ? true : !close(current, target, options);
    case 'less':
      return target === undefined ? true : current < target;
    case 'greater':
      return target === undefined ? true : current > target;
    case 'less-or-equal':
      return target === undefined ? true : current < target || close(current, target, options);
    case 'greater-or-equal':
      return target === undefined ? true : current > target || close(current, target, options);
    case 'between': {
      const low = target;
      const high = options.value2 ?? target;
      if (low === undefined || high === undefined) return true;
      const [bottom, top] = low <= high ? [low, high] : [high, low];
      return (current > bottom || close(current, bottom, options)) && (current < top || close(current, top, options));
    }
    // Delta modes can also carry a value: "changed AND now equals N" is how a Cheat Engine
    // user pins a movement down in one pass.
    case 'changed':
      return (previous === undefined || !close(current, previous, options)) && matchesTarget(current, options);
    case 'unchanged':
      return (previous === undefined || close(current, previous, options)) && matchesTarget(current, options);
    case 'increased':
      return (previous === undefined || current > previous) && matchesTarget(current, options);
    case 'decreased':
      return (previous === undefined || current < previous) && matchesTarget(current, options);
    case 'increased-by': {
      if (previous === undefined || target === undefined) return true;
      return current > previous && closeDelta(current - previous, Math.abs(target), current, previous, options);
    }
    case 'decreased-by': {
      if (previous === undefined || target === undefined) return true;
      return current < previous && closeDelta(previous - current, Math.abs(target), current, previous, options);
    }
    default:
      return true;
  }
}

function closeDelta(delta: number, target: number, current: number, previous: number, options: CompareOptions): boolean {
  if (!options.isFloat) return delta === target;
  const scaled = Math.max(Math.abs(current), Math.abs(previous)) * (options.relative ?? 0);
  return Math.abs(delta - target) <= Math.max(options.tolerance, scaled);
}

/** Modes whose first pass keeps exactly the values equal to the target (no previous value yet). */
const EXACT_FIRST_PASS = new Set<ScanMode>(['exact', 'changed', 'unchanged', 'increased', 'decreased']);

/**
 * The first-pass test, chosen once per scan. It agrees with `satisfies(mode, v, undefined, …)` for
 * every mode; the common ones skip the per-value switch.
 */
function firstPassPredicate(mode: ScanMode, options: CompareOptions): (current: number) => boolean {
  const target = options.value;
  if (target !== undefined && EXACT_FIRST_PASS.has(mode)) {
    const tolerance = options.tolerance;
    return options.isFloat ? (current) => Math.abs(current - target) <= tolerance : (current) => current === target;
  }
  if (target === undefined && mode !== 'between') return () => true;
  return (current) => satisfies(mode, current, undefined, options);
}

/**
 * The first-pass test for an integer type as an inclusive [low, high], or null for `not-equal`,
 * which is not a range. Elements are integers, so `< 2.5` is `<= 2` and an exact 2.5 is empty.
 */
function integerRange(mode: ScanMode, options: CompareOptions): [number, number] | null {
  const target = options.value;
  if (target === undefined) return mode === 'between' ? null : [-Infinity, Infinity];
  switch (mode) {
    case 'exact':
    case 'changed':
    case 'unchanged':
    case 'increased':
    case 'decreased':
      return Number.isInteger(target) ? [target, target] : [1, 0];
    case 'less':
      return [-Infinity, Math.ceil(target) - 1];
    case 'less-or-equal':
      return [-Infinity, Math.floor(target)];
    case 'greater':
      return [Math.floor(target) + 1, Infinity];
    case 'greater-or-equal':
      return [Math.ceil(target), Infinity];
    case 'between': {
      const other = options.value2 ?? target;
      return [Math.ceil(Math.min(target, other)), Math.floor(Math.max(target, other))];
    }
    case 'increased-by':
    case 'decreased-by':
      return [-Infinity, Infinity];
    default:
      return null;
  }
}

/** Little-endian 32-bit halves of a 64-bit integer, or null when no element can equal it. */
function int64Halves(value: number, unsigned: boolean): [number, number] | null {
  if (!Number.isSafeInteger(value) || (unsigned && value < 0)) return null;
  const bits = BigInt.asUintN(64, BigInt(value));
  return [Number(bits & 0xffffffffn) | 0, Number(bits >> 32n) | 0];
}

export class ScanStore {
  private readonly sessions = new Map<string, ScanSession>();
  private nextId = 1;

  get(scanId: string): ScanSession {
    const session = this.sessions.get(scanId);
    if (!session) throw new BridgeError('SCAN_CLOSED', `no scan session "${scanId}" (dropped or never created)`);
    return session;
  }

  drop(scanId: string): boolean {
    return this.sessions.delete(scanId);
  }

  dropForInstance(instanceId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.instanceId === instanceId) this.sessions.delete(id);
    }
  }

  /**
   * Runs one pass. The first pass is a full snapshot (Cheat Engine calls this
   * "unknown initial value"); later passes narrow the surviving candidates.
   */
  pass(access: MemoryAccess, options: ScanOptions): ScanSummary {
    const width = VALUE_TYPE_BYTES[options.type];
    const tolerance = options.tolerance ?? (options.value !== undefined ? defaultTolerance(options.type, options.value) : 0);
    const alignment = options.alignment ?? width;
    if (!Number.isInteger(alignment) || alignment < 1 || alignment > 16) {
      throw new BridgeError('BAD_PARAMS', `alignment must be an integer between 1 and 16, got ${String(options.alignment)}`);
    }
    if (needsValue(options.mode) && options.value === undefined) {
      throw new BridgeError('BAD_PARAMS', `mode "${options.mode}" requires a value`);
    }
    if (options.mode === 'between' && options.value2 === undefined) {
      throw new BridgeError('BAD_PARAMS', 'mode "between" requires value and value2');
    }

    const byteLength = access.byteLength;
    const start = options.range?.start ?? 0;
    const end = Math.min(options.range?.end ?? byteLength, byteLength);
    if (start < 0 || end <= start) {
      throw new BridgeError('BAD_PARAMS', `invalid scan range [${start}, ${end})`);
    }
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

    // "Unknown initial value": a delta mode with no target keeps everything, which a 250,000-entry
    // list cannot hold for a real game. Keep a copy of the bytes instead and narrow against it.
    if (options.value === undefined && isDeltaMode(options.mode)) {
      return this.snapshotPass(access, options, start, end, alignment, width);
    }

    const isFloat = options.type === 'f32' || options.type === 'f64';
    // A first pass has no previous value, so delta modes degrade to "keep everything".
    const compare: CompareOptions = { value: options.value, value2: options.value2, tolerance, isFloat };
    const matches = firstPassPredicate(options.mode, compare);

    const addresses = new Uint32Array(Math.min(maxResults, Math.ceil((end - start) / alignment) + 1));
    const values = new Float64Array(addresses.length);
    let count = 0;
    let truncated = false;

    // The loop runs once per candidate (67 million times for an i32 scan of 256 MiB). Integer tests
    // become one inclusive range with no function call in the loop, because a shared callback slows
    // down for good once scans of different types and modes have gone through it.
    const fast = alignment === width && start % width === 0;
    const first = start / width;
    const last = Math.floor(end / width); // exclusive element index
    const range = isFloat ? null : integerRange(options.mode, compare);
    const push = (offset: number, value: number): boolean => {
      if (count >= addresses.length) {
        truncated = true;
        return false;
      }
      addresses[count] = offset;
      values[count] = value;
      count++;
      return true;
    };

    if (range && range[0] > range[1]) {
      // A fractional target in an integer scan, or an empty between: nothing can match.
    } else if (fast && range && width <= 4) {
      const [low, high] = range;
      const typed = access.typedArray(options.type) as Exclude<TypedArrayLike, BigInt64Array | BigUint64Array>;
      for (let index = first; index < last; index++) {
        const value = typed[index]!;
        if (value < low || value > high) continue;
        if (!push(index * width, value)) break;
      }
    } else if (fast && range && width === 8 && range[0] === range[1]) {
      // Reading a BigInt64Array element allocates a BigInt; comparing the two 32-bit halves does not.
      const halves = int64Halves(range[0], options.type === 'u64');
      if (halves) {
        const [low, high] = halves;
        const words = new Int32Array(access.typedArray('u8').buffer);
        for (let index = first; index < last; index++) {
          if (words[index * 2] !== low || words[index * 2 + 1] !== high) continue;
          if (!push(index * width, range[0])) break;
        }
      }
    } else if (fast && width === 8) {
      const typed = access.typedArray(options.type) as BigInt64Array | BigUint64Array;
      for (let index = first; index < last; index++) {
        const value = Number(typed[index]!);
        if (!matches(value)) continue;
        if (!push(index * width, value)) break;
      }
    } else if (fast) {
      const typed = access.typedArray(options.type) as Exclude<TypedArrayLike, BigInt64Array | BigUint64Array>;
      for (let index = first; index < last; index++) {
        const value = typed[index]!;
        if (!matches(value)) continue;
        if (!push(index * width, value)) break;
      }
    } else {
      const read = access.reader(options.type);
      for (let offset = start; offset + width <= end; offset += alignment) {
        const value = read(offset);
        if (!matches(value)) continue;
        if (!push(offset, value)) break;
      }
    }

    const id = `s${this.nextId++}`;
    const session: ScanSession = {
      id,
      instanceId: options.instanceId,
      type: options.type,
      mode: options.mode,
      addresses,
      values,
      count,
      truncated,
      memoryByteLength: byteLength,
      passes: 1,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    return summarise(session, options.instanceId, options.mode, access);
  }

  private snapshotPass(access: MemoryAccess, options: ScanOptions, start: number, end: number, alignment: number, width: number): ScanSummary {
    if (end - start > MAX_SNAPSHOT_BYTES) {
      throw new BridgeError(
        'BAD_PARAMS',
        `an unknown-value scan keeps a copy of the memory it covers, and ${Math.round((end - start) / 2 ** 20)} MiB is more than ${MAX_SNAPSHOT_BYTES / 2 ** 20} MiB: scan for a value you can see, or pass a range`,
      );
    }
    const positions = end - start >= width ? Math.floor((end - start - width) / alignment) + 1 : 0;
    const bits = new Uint8Array(Math.ceil(positions / 8)).fill(0xff);
    const id = `s${this.nextId++}`;
    const session: ScanSession = {
      id,
      instanceId: options.instanceId,
      type: options.type,
      mode: options.mode,
      addresses: new Uint32Array(0),
      values: new Float64Array(0),
      count: positions,
      truncated: false,
      memoryByteLength: access.byteLength,
      passes: 1,
      createdAt: Date.now(),
      snapshot: { start, end, alignment, bytes: access.readBytes(start, end - start), bits },
    };
    this.sessions.set(id, session);
    return summarise(session, options.instanceId, options.mode, access);
  }

  /** Narrows a snapshot scan: each candidate bit is tested against the copy and cleared if it fails. */
  private narrowSnapshot(access: MemoryAccess, session: ScanSession, mode: ScanMode, compare: CompareOptions): void {
    const snapshot = session.snapshot!;
    const width = VALUE_TYPE_BYTES[session.type];
    const limit = Math.min(snapshot.end, access.byteLength);
    const readNow = access.reader(session.type);
    const readThen = viewReader(new DataView(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength), session.type);
    const addresses = new Uint32Array(SNAPSHOT_LIST_MAX);
    const values = new Float64Array(SNAPSHOT_LIST_MAX);
    const { bits, start, alignment } = snapshot;
    let survivors = 0;
    // The common case (aligned, up to 32 bits, a plain movement with no target or tolerance) is a
    // straight comparison of two typed arrays: 67 million positions in a fraction of a second.
    const movement = MOVEMENT.indexOf(mode);
    const fast =
      movement !== -1 && width <= 4 && alignment === width && start % width === 0 &&
      compare.value === undefined && compare.tolerance === 0;
    if (fast) {
      const now = access.typedArray(session.type) as Exclude<TypedArrayLike, BigInt64Array | BigUint64Array>;
      const Typed = now.constructor as new (buffer: ArrayBufferLike, offset: number, length: number) => typeof now;
      const then = new Typed(snapshot.bytes.buffer, snapshot.bytes.byteOffset, Math.floor(snapshot.bytes.byteLength / width));
      const base = start / width;
      const last = Math.floor(limit / width) - base; // exclusive position
      for (let byte = 0; byte < bits.length; byte++) {
        let mask = bits[byte]!;
        if (mask === 0) continue;
        for (let bit = 0; bit < 8; bit++) {
          const flag = 1 << bit;
          if ((mask & flag) === 0) continue;
          const position = byte * 8 + bit;
          if (position >= last) {
            mask &= ~flag;
            continue;
          }
          const current = now[base + position]!;
          const previous = then[position]!;
          const keep =
            movement === 0 ? current !== previous : movement === 1 ? current === previous : movement === 2 ? current > previous : current < previous;
          if (!keep) {
            mask &= ~flag;
            continue;
          }
          if (survivors < SNAPSHOT_LIST_MAX) {
            addresses[survivors] = (base + position) * width;
            values[survivors] = current;
          }
          survivors++;
        }
        bits[byte] = mask;
      }
    }
    for (let byte = 0; !fast && byte < bits.length; byte++) {
      let mask = bits[byte]!;
      if (mask === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        const flag = 1 << bit;
        if ((mask & flag) === 0) continue;
        const offset = start + (byte * 8 + bit) * alignment;
        if (offset + width > limit || offset + width > snapshot.end) {
          mask &= ~flag;
          continue;
        }
        const current = readNow(offset);
        if (!satisfies(mode, current, readThen(offset - start), compare)) {
          mask &= ~flag;
          continue;
        }
        if (survivors < SNAPSHOT_LIST_MAX) {
          addresses[survivors] = offset;
          values[survivors] = current;
        }
        survivors++;
      }
      bits[byte] = mask;
    }
    if (survivors <= SNAPSHOT_LIST_MAX) {
      session.snapshot = undefined;
      session.addresses = addresses.slice(0, Math.max(survivors, 1));
      session.values = values.slice(0, Math.max(survivors, 1));
    } else {
      // Still too many to list: the bytes now are what the next pass compares against.
      snapshot.bytes = access.readBytes(start, Math.min(snapshot.end, access.byteLength) - start);
    }
    session.count = survivors;
  }

  /** Narrows an existing session against its previous snapshot. */
  narrow(
    access: MemoryAccess,
    scanId: string,
    mode: ScanMode,
    options: Pick<ScanOptions, 'value' | 'value2' | 'tolerance'>,
  ): ScanSummary {
    const session = this.get(scanId);
    if (needsValue(mode) && options.value === undefined) {
      throw new BridgeError('BAD_PARAMS', `mode "${mode}" requires a value`);
    }
    if (mode === 'between' && options.value2 === undefined) {
      throw new BridgeError('BAD_PARAMS', 'mode "between" requires value and value2');
    }
    const isFloat = session.type === 'f32' || session.type === 'f64';
    const tolerance = options.tolerance ?? (options.value !== undefined ? defaultTolerance(session.type, options.value) : 0);
    const byteLength = access.byteLength;
    const grew = byteLength > session.memoryByteLength;

    const addresses = new Uint32Array(Math.max(session.count, 1));
    const values = new Float64Array(Math.max(session.count, 1));
    let count = 0;

    // A few ulps of the larger operand (f32 epsilon is 2^-23); only when the caller set no tolerance.
    const relative = options.tolerance !== undefined || !isFloat ? 0 : session.type === 'f32' ? 2 ** -22 : 2 ** -50;
    const compare: CompareOptions = { value: options.value, value2: options.value2, tolerance, isFloat, relative };
    if (session.snapshot) {
      this.narrowSnapshot(access, session, mode, compare);
      session.mode = mode;
      session.passes++;
      session.memoryByteLength = byteLength;
      session.grewDuringLastPass = grew;
      return summarise(session, session.instanceId, mode, access);
    }

    const width = VALUE_TYPE_BYTES[session.type];
    const read = access.reader(session.type);
    for (let i = 0; i < session.count; i++) {
      const offset = session.addresses[i]!;
      if (offset + width > byteLength) continue;
      const current = read(offset);
      const previous = session.values[i]!;
      if (!satisfies(mode, current, previous, compare)) continue;
      addresses[count] = offset;
      values[count] = current;
      count++;
    }

    // Values written into freshly grown memory start at 0; keep that visible to the
    // agent instead of silently pretending those bytes never existed.
    session.addresses = addresses;
    session.values = values;
    session.count = count;
    session.mode = mode;
    session.truncated = false;
    session.passes++;
    session.memoryByteLength = byteLength;
    session.grewDuringLastPass = grew;

    return summarise(session, session.instanceId, mode, access);
  }

  /**
   * Freeze a session for storage. Only the live part of the arrays is copied, so a scan that once
   * held 250,000 candidates and narrowed to six stores six.
   */
  serialize(scanId: string): SavedScanData {
    const session = this.get(scanId);
    if (session.snapshot) {
      throw new BridgeError('UNSUPPORTED', 'this scan still has every address as a candidate; narrow it once (went up, went down) before saving it');
    }
    const addresses = session.addresses.slice(0, session.count);
    const values = session.values.slice(0, session.count);
    return {
      instanceId: session.instanceId,
      type: session.type,
      mode: session.mode,
      count: session.count,
      addresses: toBase64(new Uint8Array(addresses.buffer, addresses.byteOffset, addresses.byteLength)),
      values: toBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)),
      memoryByteLength: session.memoryByteLength,
      passes: session.passes,
      createdAt: session.createdAt,
    };
  }

  /**
   * Rebuild a session from a saved snapshot. After a reload the instance keeps its id (`w1`) but the
   * heap can be a different size, so addresses that no longer fit are dropped instead of throwing on
   * the next read, and the count that comes back is the honest one.
   */
  adopt(access: MemoryAccess, data: SavedScanData): { scanId: string; summary: ScanSummary } {
    const width = VALUE_TYPE_BYTES[data.type];
    const addresses = new Uint32Array(fromBase64(data.addresses).buffer);
    const values = new Float64Array(fromBase64(data.values).buffer);
    const limit = access.byteLength;
    let count = 0;
    for (let index = 0; index < addresses.length && index < values.length; index++) {
      const address = addresses[index]!;
      if (address + width > limit) continue;
      addresses[count] = address;
      values[count] = values[index]!;
      count++;
    }

    const session: ScanSession = {
      id: `s${this.nextId++}`,
      instanceId: data.instanceId,
      type: data.type,
      mode: data.mode,
      addresses,
      values,
      count,
      truncated: false,
      memoryByteLength: limit,
      passes: data.passes,
      createdAt: data.createdAt,
    };
    this.sessions.set(session.id, session);
    return { scanId: session.id, summary: summarise(session, session.instanceId, session.mode, access) };
  }

  results(scanId: string, access: MemoryAccess, offset: number, limit: number): { hits: ScanHit[]; total: number } {
    const session = this.get(scanId);
    const total = session.count;
    // Every address is a candidate: listing the first hundred of millions would only mislead.
    if (session.snapshot) return { hits: [], total };
    const start = Math.max(0, Math.min(offset, total));
    const end = Math.min(total, start + Math.max(0, limit));
    const hits: ScanHit[] = [];
    for (let i = start; i < end; i++) {
      const address = session.addresses[i]!;
      const width = VALUE_TYPE_BYTES[session.type];
      const readable = address + width <= access.byteLength;
      hits.push({
        address: { instanceId: session.instanceId, offset: address },
        value: readable ? access.read(address, session.type) : Number.NaN,
        previous: session.values[i],
      });
    }
    return { hits, total };
  }
}

/**
 * Byte search for ascii/utf8/hex needles. Games keep names, ids and prices as strings, and a
 * numeric scan can never find those.
 */
export function scanText(access: MemoryAccess, options: TextScanOptions): TextScanResult {
  const encoding = options.encoding ?? 'ascii';
  const needle = encodeNeedle(options.text, encoding);
  if (needle.length === 0) throw new BridgeError('BAD_PARAMS', 'text to search for is empty');

  const byteLength = access.byteLength;
  const start = options.range?.start ?? 0;
  const end = Math.min(options.range?.end ?? byteLength, byteLength);
  if (start < 0 || end <= start) throw new BridgeError('BAD_PARAMS', `invalid scan range [${start}, ${end})`);
  if (needle.length > end - start) {
    return { encoding, matches: [], total: 0, truncated: false, memoryByteLength: byteLength };
  }

  const haystack = access.readBytes(start, end - start);
  const folded = options.caseSensitive === false && encoding !== 'bytes';
  if (folded) {
    asciiLowerInPlace(haystack);
    // Both sides fold, or "Player" never matches. UTF-8 multibyte bytes are >= 0x80 and stay as they are.
    asciiLowerInPlace(needle);
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const matches: number[] = [];
  let total = 0;
  for (let at = indexOfBytes(haystack, needle, 0); at !== -1; at = indexOfBytes(haystack, needle, at + 1)) {
    total++;
    if (matches.length < maxResults) matches.push(start + at);
  }
  return { encoding, matches, total, truncated: total > matches.length, memoryByteLength: byteLength };
}

function encodeNeedle(text: string, encoding: TextScanOptions['encoding']): Uint8Array {
  if (encoding === 'bytes') {
    const hex = text.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 0 || hex.length % 2 !== 0) {
      throw new BridgeError('BAD_PARAMS', 'encoding "bytes" expects an even-length hex string like "deadbeef"');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (encoding === 'utf8') return new TextEncoder().encode(text);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new BridgeError('BAD_PARAMS', 'encoding "ascii" cannot encode characters above 0x7f; use utf8');
    out[i] = code;
  }
  return out;
}

function asciiLowerInPlace(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte >= 0x41 && byte <= 0x5a) bytes[i] = byte + 0x20;
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  const first = needle[0]!;
  for (let i = from; i <= last; i++) {
    if (haystack[i] !== first) continue;
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

function summarise(session: ScanSession, instanceId: string, mode: ScanMode, access: MemoryAccess): ScanSummary {
  const sampleSize = session.snapshot ? 0 : Math.min(8, session.count);
  const sample: ScanHit[] = [];
  for (let i = 0; i < sampleSize; i++) {
    const offset = session.addresses[i]!;
    const width = VALUE_TYPE_BYTES[session.type];
    sample.push({
      address: { instanceId, offset },
      value: offset + width <= access.byteLength ? access.read(offset, session.type) : Number.NaN,
    });
  }
  return {
    scanId: session.id,
    mode,
    type: session.type,
    matchCount: session.count,
    truncated: session.truncated,
    sample,
    memoryByteLength: access.byteLength,
  };
}


const BASE64_CHUNK = 0x8000;

/** `sessionStorage` holds strings only, and spreading a whole heap-sized array would blow the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
