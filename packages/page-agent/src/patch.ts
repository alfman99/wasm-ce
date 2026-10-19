import {
  BridgeError,
  PATCH_MODES,
  type PatchEntry,
  type PatchMode,
  type PatchSpec,
} from '@wasmcheat/protocol';
import type { FunctionPatch } from '@wasmcheat/wasm-instrument';

/**
 * Patches live in `sessionStorage` for the same reason watchpoints do: a function body can only be
 * replaced before the engine compiles the module, so a patch is written down, the tab is reloaded,
 * and the page agent re-applies it while the module streams past. `sessionStorage` is per-origin,
 * survives exactly the reload we own, and disappears when the tab closes.
 */
const STORAGE_KEY = 'wasmcheat.patches';

interface StoredPatch {
  target: string;
  mode: PatchMode;
  value?: number;
  note?: string;
}

/**
 * Function-body patches: stub a function out with a constant return.
 *
 * This is the only way to switch off behaviour a module keeps entirely to itself — a damage
 * routine, a cooldown, a check — because such a function appears in neither the export nor the
 * import list, so there is nothing to wrap. The rewrite happens in `@wasmcheat/wasm-instrument`
 * and the tool reports the patch as pending until a module is instantiated with it.
 */
export class PatchStore {
  private entries: PatchEntry[] = [];
  private nextId = 1;

  constructor(private readonly onWiringChange: () => void) {
    this.restore();
  }

  add(spec: PatchSpec): PatchEntry {
    if (!PATCH_MODES.includes(spec.mode)) {
      throw new BridgeError('BAD_PARAMS', `unknown patch mode "${String(spec.mode)}"`);
    }
    if (!spec.target || !spec.target.trim()) {
      throw new BridgeError('BAD_PARAMS', 'patch target must be an export name or "wasm-function[N]"');
    }
    const entry: PatchEntry = {
      id: `p${this.nextId++}`,
      target: spec.target.trim(),
      mode: spec.mode,
      ...(spec.value !== undefined ? { value: spec.value } : {}),
      ...(spec.note ? { note: spec.note } : {}),
      applied: false,
      applications: 0,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    this.persist();
    this.onWiringChange();
    return { ...entry };
  }

  list(): PatchEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  remove(id: string): PatchEntry[] {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) {
      throw new BridgeError('BAD_PARAMS', `no patch with id "${id}"`);
    }
    this.persist();
    this.onWiringChange();
    return this.list();
  }

  clear(): PatchEntry[] {
    this.entries = [];
    this.persist();
    this.onWiringChange();
    return [];
  }

  /** What the rewriter should apply, in the order the entries were added. */
  activePatches(): FunctionPatch[] {
    return this.entries.map((entry) => {
      const index = parseFunctionIndex(entry.target);
      const base: FunctionPatch = { mode: entry.mode };
      if (entry.value !== undefined) base.value = entry.value;
      if (index !== null) return { ...base, function: index };
      return { ...base, byName: entry.target };
    });
  }

  get active(): boolean {
    return this.entries.length > 0;
  }

  /**
   * Called after a successful rewrite. `patchedFunctions` lists the defined-function index of every
   * patch, in the order the patches were handed to the rewriter, so the zip is exact.
   */
  markApplied(patchedFunctions: number[]): void {
    this.entries.forEach((entry, i) => {
      const index = patchedFunctions[i];
      entry.applied = true;
      entry.applications += 1;
      if (typeof index === 'number') entry.funcIndex = index;
    });
    this.persist();
  }

  private persist(): void {
    try {
      const stored: StoredPatch[] = this.entries.map((entry) => ({
        target: entry.target,
        mode: entry.mode,
        ...(entry.value !== undefined ? { value: entry.value } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      }));
      if (stored.length === 0) sessionStorage.removeItem(STORAGE_KEY);
      else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // A page that denies storage still gets a working session; it just cannot survive a reload.
    }
  }

  private restore(): void {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as StoredPatch[];
      if (!Array.isArray(stored)) return;
      for (const item of stored) {
        if (!item?.target || !PATCH_MODES.includes(item.mode)) continue;
        this.entries.push({
          id: `p${this.nextId++}`,
          target: item.target,
          mode: item.mode,
          ...(typeof item.value === 'number' ? { value: item.value } : {}),
          ...(item.note ? { note: item.note } : {}),
          applied: false,
          applications: 0,
          createdAt: Date.now(),
        });
      }
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }
}

/** `wasm-function[12]` is how `list_instances` names a function the module does not export. */
export function parseFunctionIndex(target: string): number | null {
  const match = /^wasm-function\[(\d+)\]$/.exec(target.trim());
  if (!match?.[1]) return null;
  return Number(match[1]);
}
