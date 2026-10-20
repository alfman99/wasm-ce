import { describe, expect, it } from 'vitest';
import { physicsEngine, wasmUrlsIn } from '../../packages/page-agent/src/runtime';

const urls = (text: string): string[] => {
  const found = new Set<string>();
  wasmUrlsIn(text, found);
  return [...found];
};

describe('wasmUrlsIn', () => {
  it('finds the URLs a page names in markup and script', () => {
    expect(urls('<link href="Build/DR69_PG.wasm">')).toEqual(['Build/DR69_PG.wasm']);
    expect(urls("fetch('files/assets/31014538/1/ammo.wasm?v=2').then(go)")).toEqual(['files/assets/31014538/1/ammo.wasm?v=2']);
    expect(urls('codeUrl: buildUrl + "/game.wasm", other: "/game.wasm"')).toEqual(['/game.wasm']);
    expect(urls('no modules here')).toEqual([]);
  });

  it('stays linear on a long run with no delimiter, which the old regex took seconds over', () => {
    const minified = 'A'.repeat(2_000_000) + 'x.wasm';
    const started = performance.now();
    const found = urls(minified);
    expect(performance.now() - started).toBeLessThan(100);
    // The walk back is bounded, so a URL glued to megabytes of code is reported by its tail.
    expect(found[0]?.endsWith('x.wasm')).toBe(true);
    expect(found[0]!.length).toBeLessThanOrEqual(406);
  });
});

describe('physicsEngine', () => {
  it('names the engine only when every module is one', () => {
    expect(physicsEngine(['files/assets/31014538/1/ammo.wasm'])).toBe('Ammo.js (Bullet)');
    expect(physicsEngine(['https://cdn.example/box2d.release.wasm'])).toBe('Box2D');
    expect(physicsEngine(['Build/game.wasm', 'ammo.wasm'])).toBeUndefined();
    expect(physicsEngine([])).toBeUndefined();
  });
});
