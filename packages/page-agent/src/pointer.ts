import { BridgeError, formatAddress, type PointerPath, type PointerScanOptions } from '@wasmcheat/protocol';
import type { MemoryAccess } from './memory.js';

/** Offsets are tried on a 4-byte grid: a wasm pointer is an index into linear memory. */
const OFFSET_STEP = 4;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_OFFSET = 0x400;
const DEFAULT_MAX_RESULTS = 20;
const MAX_NODES = 20_000;

/**
 * Pointer scanning: follow the chain from a static location to the address you care about.
 *
 * Cheat Engine's version of this exists because pointers are how a real program keeps a value
 * reachable across reallocations: the address moves, the path does not. In wasm the model is much
 * simpler — a pointer is a 32-bit offset into one linear memory — so the whole scan is an index of
 * every word that looks like a pointer, walked backwards from the target. No process memory, no
 * module bases, no rebasing.
 *
 * The scan is deliberately breadth-first and bounded: a backward walk over a 16 MB heap has few
 * natural stopping points, so depth, node count and result count are all capped.
 */
export function pointerScan(access: MemoryAccess, options: PointerScanOptions): PointerPath[] {
  const target = options.offset;
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, 6));
  const maxOffset = Math.max(OFFSET_STEP, Math.min(options.maxOffset ?? DEFAULT_MAX_OFFSET, 0x100_000));
  const maxResults = Math.max(1, Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, 100));

  const byteLength = access.byteLength;
  if (target >= byteLength) {
    throw new BridgeError('OUT_OF_RANGE', `address ${formatAddress({ instanceId: options.instanceId, offset: target })} is outside memory`);
  }

  const pointers = indexPointers(access, byteLength);
  const results: PointerPath[] = [];
  /** A node is an address we still have to explain, plus the offsets from it to the target. */
  interface Node {
    address: number;
    offsets: number[];
    hops: number[];
  }
  let frontier: Node[] = [{ address: target, offsets: [], hops: [target] }];
  let nodes = 1;

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && results.length < maxResults; depth += 1) {
    const next: Node[] = [];
    for (const node of frontier) {
      for (let offset = 0; offset <= maxOffset && results.length < maxResults; offset += OFFSET_STEP) {
        const wanted = node.address - offset;
        if (wanted < 0) continue;
        for (const holder of pointers.get(wanted) ?? []) {
          if (node.hops.includes(holder)) continue; // a pointer cycle, not a path
          if (++nodes > MAX_NODES) {
            throw new BridgeError(
              'UNSUPPORTED',
              `pointer scan exceeded ${MAX_NODES} nodes; lower maxDepth or maxOffset`,
            );
          }
          const offsets = [offset, ...node.offsets];
          results.push({
            base: { instanceId: options.instanceId, offset: holder },
            baseValue: wanted,
            offsets,
            depth: depth + 1,
            target: { instanceId: options.instanceId, offset: target },
          });
          next.push({ address: holder, offsets, hops: [holder, ...node.hops] });
        }
      }
    }
    frontier = next;
  }

  // Shallowest first: the shortest chain is the least likely to break.
  results.sort((left, right) => left.depth - right.depth || left.offsets.length - right.offsets.length);
  return results.slice(0, maxResults);
}

/**
 * Every word that can be a pointer, by value. Words outside `(0, byteLength)` cannot point into
 * linear memory, which keeps the index small even on a large heap.
 */
function indexPointers(access: MemoryAccess, byteLength: number): Map<number, number[]> {
  const words = new Uint32Array(byteLength >>> 2);
  for (let offset = 0; offset + 4 <= byteLength; offset += OFFSET_STEP) words[offset >>> 2] = access.read(offset, 'u32');
  const index = new Map<number, number[]>();
  for (let i = 0; i < words.length; i += 1) {
    const value = words[i] ?? 0;
    if (value === 0 || value >= byteLength) continue;
    const address = i * OFFSET_STEP;
    const holders = index.get(value);
    if (holders) holders.push(address);
    else index.set(value, [address]);
  }
  return index;
}

/**
 * Walk one path and report every hop, so an agent can see whether each level still points at the
 * expected thing (a stale pointer shows up as a value that is no longer an address).
 */
export function pointerResolve(
  access: MemoryAccess,
  instanceId: string,
  base: number,
  offsets: number[],
): { hops: { address: string; value: number }[]; final: string; value: number | null } {
  const hops: { address: string; value: number }[] = [];
  let address = base;
  for (const offset of offsets) {
    const value = access.read(address, 'u32');
    hops.push({ address: formatAddress({ instanceId, offset: address }), value });
    address = value + offset;
    if (address >= access.byteLength) {
      return { hops, final: formatAddress({ instanceId, offset: address }), value: null };
    }
  }
  return { hops, final: formatAddress({ instanceId, offset: address }), value: access.read(address, 'u32') };
}
