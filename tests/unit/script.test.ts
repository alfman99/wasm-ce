import { describe, expect, it } from 'vitest';
import { runScript, until } from '../../packages/page-agent/src/script';

describe('runScript', () => {
  it('returns the value of an expression, of a pasted IIFE and of a body that returns', async () => {
    expect((await runScript('1 + 2')).value).toBe(3);
    // What the console takes: an IIFE ending in a semicolon, returning a string.
    expect(await runScript("(() => {\n  const a = 'aim line';\n  return `${a} on`;\n})();")).toMatchObject({ value: 'aim line on', type: 'string' });
    expect((await runScript('const list = [1, 2, 3];\nreturn list.length;')).value).toBe(3);
    expect((await runScript('await new Promise((r) => setTimeout(r, 5)); return "later";')).value).toBe('later');
  });

  it('makes any value safe to send back', async () => {
    expect(await runScript('undefined')).toMatchObject({ value: null, type: 'undefined' });
    expect(await runScript('null')).toMatchObject({ value: null, type: 'null' });
    expect(await runScript('[1, "a"]')).toMatchObject({ value: [1, 'a'], type: 'array' });
    expect((await runScript('10n')).value).toBe('10');
    expect((await runScript('(() => { const o = { name: "loop" }; o.self = o; return o; })()')).value).toEqual({ name: 'loop', self: '[circular]' });
    expect((await runScript('({ run() {} })')).value).toEqual({ run: '[function run]' });
    const big = await runScript("'x'.repeat(100000)");
    expect(big.truncated).toBe(true);
    expect(String(big.value).length).toBeLessThan(70_000);
  });

  it('reports a script that throws or does not parse as the caller’s mistake', async () => {
    await expect(runScript('')).rejects.toMatchObject({ code: 'BAD_PARAMS' });
    await expect(runScript('throw new Error("nope")')).rejects.toMatchObject({ code: 'BAD_PARAMS', message: expect.stringContaining('Error: nope') });
    await expect(runScript('missingThing.value')).rejects.toMatchObject({ message: expect.stringContaining('ReferenceError') });
    await expect(runScript('return (')).rejects.toMatchObject({ code: 'BAD_PARAMS', message: expect.stringContaining('does not parse') });
  });
});

describe('until and once, what a mod is made of', () => {
  it('waits for a check to turn truthy, ignores throws on the way, and gives up after the timeout', async () => {
    const box: { app?: { name: string } } = {};
    setTimeout(() => (box.app = { name: 'game' }), 30);
    await expect(until(() => box.app!.name, 1000, 5)).resolves.toBe('game');
    await expect(until(() => null, 40, 5)).rejects.toThrow('nothing after 40 ms');
    // Scripts get it as a free name: a mod starts before the engine exists and waits for it.
    expect((await runScript('const v = await until(() => 7); return v * 2;')).value).toBe(14);
  });

  it('runs a script with a once key a single time per page, and again if the first run threw', async () => {
    const first = await runScript('globalThis.__onceCount = (globalThis.__onceCount ?? 0) + 1', 'mod-a');
    expect(first.value).toBe(1);
    expect(await runScript('globalThis.__onceCount = (globalThis.__onceCount ?? 0) + 1', 'mod-a')).toMatchObject({ skipped: true });
    await expect(runScript('throw new Error("not yet")', 'mod-b')).rejects.toThrow('not yet');
    expect((await runScript('"second try"', 'mod-b')).value).toBe('second try');
  });
});
