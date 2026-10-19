import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addBookmark, clearBookmarks, listBookmarks, removeBookmark } from '../../packages/page-agent/src/bookmarks.js';

/** localStorage, as much of it as the bookmark store touches. */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
  return data;
}

describe('bookmarks', () => {
  let data: Map<string, string>;

  beforeEach(() => {
    data = installStorage();
  });

  it('adds a labelled address and lists it', () => {
    const bookmark = addBookmark({ label: 'score', address: 'w1:0x408', type: 'i32' });
    expect(bookmark.label).toBe('score');
    expect(bookmark.type).toBe('i32');
    expect(listBookmarks()).toEqual([bookmark]);
  });

  it('keeps them sorted by label so a long list is readable', () => {
    addBookmark({ label: 'score', address: 'w1:0x408' });
    addBookmark({ label: 'coins', address: 'w1:0x40c' });
    expect(listBookmarks().map((bookmark) => bookmark.label)).toEqual(['coins', 'score']);
  });

  it('replaces a duplicate label instead of leaving a stale address next to a fresh one', () => {
    addBookmark({ label: 'score', address: 'w1:0x408' });
    addBookmark({ label: 'score', address: 'w1:0x508' });
    const bookmarks = listBookmarks();
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]!.address).toBe('w1:0x508');
  });

  it('survives a new page load, because it is local storage and not a module variable', () => {
    addBookmark({ label: 'lives', address: 'w1:0x400' });
    // Same storage, fresh module state: a reload has the same effect.
    vi.resetModules();
    expect(listBookmarks().map((bookmark) => bookmark.label)).toEqual(['lives']);
  });

  it('removes by id and by label, and reports when nothing matched', () => {
    const first = addBookmark({ label: 'a', address: 'w1:0x10' });
    addBookmark({ label: 'b', address: 'w1:0x20' });
    expect(removeBookmark(first.id)).toBe(true);
    expect(removeBookmark('b')).toBe(true);
    expect(listBookmarks()).toEqual([]);
    expect(removeBookmark('nope')).toBe(false);
  });

  it('clears everything and reports how many were dropped', () => {
    addBookmark({ label: 'a', address: 'w1:0x10' });
    addBookmark({ label: 'b', address: 'w1:0x20' });
    expect(clearBookmarks()).toBe(2);
    expect(listBookmarks()).toEqual([]);
  });

  it('rejects an address that is not an address and a label that is blank', () => {
    expect(() => addBookmark({ label: 'score', address: 'not-an-address' })).toThrow(/must look like/);
    expect(() => addBookmark({ label: '   ', address: 'w1:0x10' })).toThrow(/cannot be empty/);
    expect(() => addBookmark({ label: 'x'.repeat(65), address: 'w1:0x10' })).toThrow(/longer than 64/);
  });

  it('ignores a corrupted list instead of throwing at the caller', () => {
    data.set('wasmcheat.bookmarks', '{not json');
    expect(listBookmarks()).toEqual([]);
    expect(addBookmark({ label: 'score', address: 'w1:0x408' }).label).toBe('score');
  });
});
