import { BridgeError, type SavedScanData, type SavedScanSummary } from '@wasmcheat/protocol';

/**
 * Saved scans live in `sessionStorage`, not in the extension, because the data is the page's own
 * memory offsets: they mean nothing in another tab and everything in this one after a reload.
 * (The bridge token case is the same idea in reverse.)
 */
const STORAGE_KEY = 'wasmcheat.scans';
const MAX_SAVED = 40;
const MAX_NAME = 64;

interface SavedRecord extends SavedScanSummary {
  data: SavedScanData;
}

function isRecord(value: unknown): value is SavedRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SavedRecord>;
  return typeof record.name === 'string' && typeof record.matchCount === 'number' && !!record.data;
}

function read(): SavedRecord[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    // A sandboxed frame has no storage access; saving then simply cannot persist, which is
    // reported by the caller rather than thrown at the user mid-scan.
    return [];
  }
}

function write(records: SavedRecord[]): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function normaliseName(name: unknown): string {
  if (typeof name !== 'string') throw new BridgeError('BAD_PARAMS', 'name is required');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new BridgeError('BAD_PARAMS', 'name cannot be empty');
  if (trimmed.length > MAX_NAME) throw new BridgeError('BAD_PARAMS', `name cannot be longer than ${MAX_NAME} characters`);
  return trimmed;
}

function summarise(record: SavedRecord): SavedScanSummary {
  const { name, createdAt, type, mode, matchCount, instanceId, memoryByteLength } = record;
  return { name, createdAt, type, mode, matchCount, instanceId, memoryByteLength };
}

export function listSaved(): SavedScanSummary[] {
  return read()
    .map(summarise)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function saveScan(name: unknown, data: SavedScanData): SavedScanSummary {
  const trimmed = normaliseName(name);
  const records = read().filter((record) => record.name !== trimmed);
  records.unshift({
    name: trimmed,
    createdAt: data.createdAt,
    type: data.type,
    mode: data.mode,
    matchCount: data.count,
    instanceId: data.instanceId,
    memoryByteLength: data.memoryByteLength,
    data,
  });
  if (!write(records.slice(0, MAX_SAVED))) {
    throw new BridgeError('UNSUPPORTED', 'this page has no session storage, so a scan cannot be saved here');
  }
  return summarise(records[0]!);
}

export function loadSaved(name: unknown): SavedScanData {
  const trimmed = normaliseName(name);
  const record = read().find((item) => item.name === trimmed);
  if (!record) throw new BridgeError('BAD_PARAMS', `no saved scan named "${trimmed}"`);
  return record.data;
}

export function deleteSaved(name: unknown): boolean {
  const trimmed = normaliseName(name);
  const records = read();
  const remaining = records.filter((record) => record.name !== trimmed);
  if (remaining.length === records.length) return false;
  write(remaining);
  return true;
}
