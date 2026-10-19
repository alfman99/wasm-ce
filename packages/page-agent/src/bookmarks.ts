import { BridgeError, type Bookmark, type ValueType } from '@wasmcheat/protocol';

/**
 * Bookmarks are the address list: a label, an address and an optional type, kept in `localStorage`
 * rather than `sessionStorage` because a label like "score" is still the thing you want tomorrow.
 * They are per origin (localStorage always is), which is correct here: an offset found in one site
 * means nothing in another.
 */
const STORAGE_KEY = 'wasmcheat.bookmarks';
const MAX_BOOKMARKS = 200;
const MAX_LABEL = 64;

function isBookmark(value: unknown): value is Bookmark {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Bookmark>;
  return typeof record.id === 'string' && typeof record.label === 'string' && typeof record.address === 'string';
}

function read(): Bookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isBookmark) : [];
  } catch {
    return [];
  }
}

function write(bookmarks: Bookmark[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    throw new BridgeError('UNSUPPORTED', 'this page has no local storage, so a bookmark cannot be saved here');
  }
}

function normaliseLabel(label: unknown): string {
  if (typeof label !== 'string') throw new BridgeError('BAD_PARAMS', 'label is required');
  const trimmed = label.trim();
  if (trimmed.length === 0) throw new BridgeError('BAD_PARAMS', 'label cannot be empty');
  if (trimmed.length > MAX_LABEL) throw new BridgeError('BAD_PARAMS', `label cannot be longer than ${MAX_LABEL} characters`);
  return trimmed;
}

function normaliseAddress(address: unknown): string {
  if (typeof address !== 'string' || !/^[A-Za-z0-9_-]+:(\d+|0x[0-9a-fA-F]+)$/.test(address.trim())) {
    throw new BridgeError('BAD_PARAMS', 'address must look like "w1:0x408"');
  }
  return address.trim();
}

export function listBookmarks(): Bookmark[] {
  return read().sort((left, right) => left.label.localeCompare(right.label));
}

/** Adding a label that already exists replaces it, so a stale address never lingers next to a fresh one. */
export function addBookmark(input: { label: unknown; address: unknown; type?: unknown; note?: unknown }): Bookmark {
  const label = normaliseLabel(input.label);
  const address = normaliseAddress(input.address);
  const type = typeof input.type === 'string' ? (input.type as ValueType) : undefined;
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : undefined;
  const existing = read().filter((bookmark) => bookmark.label !== label);
  if (existing.length >= MAX_BOOKMARKS) {
    throw new BridgeError('BAD_PARAMS', `there are already ${MAX_BOOKMARKS} bookmarks; remove one first`);
  }
  // Ids only need to be unique inside one page's list; two adds in the same millisecond are normal.
  const serial = existing.reduce((highest, item) => Math.max(highest, Number(item.id.slice(item.id.lastIndexOf('-') + 1)) || 0), 0) + 1;
  const bookmark: Bookmark = {
    id: `b${Date.now().toString(36)}-${serial}`,
    label,
    address,
    type,
    note,
    createdAt: Date.now(),
  };
  write([...existing, bookmark]);
  return bookmark;
}

export function removeBookmark(id: unknown): boolean {
  if (typeof id !== 'string') throw new BridgeError('BAD_PARAMS', 'id is required');
  const bookmarks = read();
  const remaining = bookmarks.filter((bookmark) => bookmark.id !== id && bookmark.label !== id);
  if (remaining.length === bookmarks.length) return false;
  write(remaining);
  return true;
}

export function clearBookmarks(): number {
  const count = read().length;
  write([]);
  return count;
}
