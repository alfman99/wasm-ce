import { BridgeError, type ScanHit, type ScanMode, type ScanOptions, type ScanSummary, type ValueType, VALUE_TYPE_BYTES } from '@wasmcheat/protocol';
import { MemoryAccess, defaultTolerance } from './memory.js';

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
  createdAt: number;
}

const DEFAULT_MAX_RESULTS = 250_000;

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
    if (options.mode === 'exact' && options.value === undefined) {
      throw new BridgeError('BAD_PARAMS', 'mode "exact" requires a value');
    }

    const byteLength = access.byteLength;
    const start = options.range?.start ?? 0;
    const end = Math.min(options.range?.end ?? byteLength, byteLength);
    if (start < 0 || end <= start) {
      throw new BridgeError('BAD_PARAMS', `invalid scan range [${start}, ${end})`);
    }
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

    const isFloat = options.type === 'f32' || options.type === 'f64';
    const target = options.value;
    const matchesExact = (value: number): boolean => {
      if (target === undefined) return true;
      if (isFloat) return Math.abs(value - target) <= tolerance;
      return value === target;
    };

    const addresses = new Uint32Array(Math.min(maxResults, Math.ceil((end - start) / alignment) + 1));
    const values = new Float64Array(addresses.length);
    let count = 0;
    let truncated = false;

    // Fast path: aligned access maps straight onto a typed array, which is ~5x
    // quicker than DataView on a multi-megabyte scan.
    const fast = alignment === width && start % width === 0;
    const typed = fast ? access.typedArray(options.type) : null;

    for (let offset = start; offset + width <= end; offset += alignment) {
      let value: number;
      if (typed) {
        const raw = typed[offset / width];
        value = typeof raw === 'bigint' ? Number(raw) : (raw as number);
      } else {
        value = access.read(offset, options.type);
      }
      if (!matchesExact(value)) continue;
      if (count >= addresses.length) {
        truncated = true;
        break;
      }
      addresses[count] = offset;
      values[count] = value;
      count++;
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

  /** Narrows an existing session against its previous snapshot. */
  narrow(access: MemoryAccess, scanId: string, mode: ScanMode, options: Pick<ScanOptions, 'value' | 'tolerance'>): ScanSummary {
    const session = this.get(scanId);
    const isFloat = session.type === 'f32' || session.type === 'f64';
    const tolerance = options.tolerance ?? (options.value !== undefined ? defaultTolerance(session.type, options.value) : 0);
    const target = options.value;
    const byteLength = access.byteLength;
    const grew = byteLength > session.memoryByteLength;

    const addresses = new Uint32Array(Math.max(session.count, 1));
    const values = new Float64Array(Math.max(session.count, 1));
    let count = 0;

    const sameValue = (a: number, b: number): boolean => (isFloat ? Math.abs(a - b) <= tolerance : a === b);
    const matchesTarget = (value: number): boolean => {
      if (target === undefined) return true;
      if (isFloat) return Math.abs(value - target) <= tolerance;
      return value === target;
    };

    for (let i = 0; i < session.count; i++) {
      const offset = session.addresses[i]!;
      if (offset + VALUE_TYPE_BYTES[session.type] > byteLength) continue;
      const current = access.read(offset, session.type);
      const previous = session.values[i]!;
      const keep =
        mode === 'exact'
          ? matchesTarget(current)
          : mode === 'changed'
            ? !sameValue(current, previous) && matchesTarget(current)
            : mode === 'unchanged'
              ? sameValue(current, previous) && matchesTarget(current)
              : mode === 'increased'
                ? current > previous && matchesTarget(current)
                : current < previous && matchesTarget(current);
      if (!keep) continue;
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

  results(scanId: string, access: MemoryAccess, offset: number, limit: number): { hits: ScanHit[]; total: number } {
    const session = this.get(scanId);
    const total = session.count;
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
      });
    }
    return { hits, total };
  }
}

function summarise(session: ScanSession, instanceId: string, mode: ScanMode, access: MemoryAccess): ScanSummary {
  const sampleSize = Math.min(8, session.count);
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

