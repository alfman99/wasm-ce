import { BridgeError, type ScriptResult } from '@wasmcheat/protocol';

/** A result is a reply over postMessage and a WebSocket, so it is cut before it gets heavy. */
const MAX_RESULT_CHARS = 64 * 1024;

/** Keys of the scripts that already ran in this realm, so a mod delivered twice runs once. */
const ranOnce = new Set<string>();

/**
 * Handed to every script as `until`: waits for `check()` to return something truthy and resolves to
 * it. A mod runs as soon as its frame starts, before the engine exists, so it begins with
 * `const app = await until(() => window.pc?.app)`. A check that throws counts as not yet.
 */
export function until<T>(check: () => T, timeoutMs = 30_000, everyMs = 100): Promise<NonNullable<T>> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      let value: T | undefined;
      try {
        value = check();
      } catch {
        value = undefined;
      }
      if (value) resolve(value as NonNullable<T>);
      else if (Date.now() - started >= timeoutMs) reject(new Error(`until: nothing after ${timeoutMs} ms`));
      else setTimeout(tick, everyMs);
    };
    tick();
  });
}

/**
 * Runs code in this frame, the one that holds the game, so a mod that has to reach the engine
 * (`pc.app` in PlayCanvas, `unityInstance` in Unity) needs no DevTools console and no picking the
 * right frame by hand. The code is either an expression (an IIFE, `pc.version`) whose value comes
 * back, or a function body that returns one; either may await.
 */
export async function runScript(code: unknown, once?: unknown): Promise<ScriptResult> {
  if (typeof code !== 'string' || !code.trim()) {
    throw new BridgeError('BAD_PARAMS', 'code must be a non-empty string');
  }
  if (typeof once === 'string') {
    if (ranOnce.has(once)) return { value: null, type: 'undefined', ms: 0, skipped: true };
    ranOnce.add(once);
  }
  const run = compile(code);
  const started = performance.now();
  let value: unknown;
  try {
    value = await run(until);
  } catch (error) {
    if (typeof once === 'string') ranOnce.delete(once);
    throw new BridgeError('BAD_PARAMS', `the script threw: ${describeError(error)}`);
  }
  return { ...serialise(value), ms: Math.round(performance.now() - started) };
}

type Compiled = (helper: typeof until) => Promise<unknown>;

function compile(code: string): Compiled {
  // An expression first, so pasted console code (an IIFE ending in `;`) returns its value; a
  // body with statements is not an expression, so it is compiled as a body instead.
  const expression = code.trim().replace(/;+\s*$/, '');
  try {
    // eslint-disable-next-line no-new-func
    return new Function('until', `return (async () => (\n${expression}\n))();`) as Compiled;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw blocked(error);
  }
  try {
    // eslint-disable-next-line no-new-func
    return new Function('until', `return (async () => {\n${code}\n})();`) as Compiled;
  } catch (error) {
    if (error instanceof SyntaxError) throw new BridgeError('BAD_PARAMS', `the script does not parse: ${error.message}`);
    throw blocked(error);
  }
}

/** Anything but a syntax error from `new Function` is the page's CSP or Trusted Types saying no. */
function blocked(error: unknown): BridgeError {
  return new BridgeError(
    'HOOK_EVAL_BLOCKED',
    `this page does not allow running scripts (${describeError(error)}); its Content-Security-Policy blocks eval`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** JSON-safe, cycle-safe and bounded, because the value crosses two message channels. */
function serialise(value: unknown): Omit<ScriptResult, 'ms'> {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return { type, value: value === undefined ? null : String(value) };
  }
  const seen = new WeakSet<object>();
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function') return `[function ${item.name || 'anonymous'}]`;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    text = undefined;
  }
  if (text === undefined) return { type, value: String(value) };
  if (text.length > MAX_RESULT_CHARS) {
    return { type, value: `${text.slice(0, MAX_RESULT_CHARS)}…`, truncated: true };
  }
  return { type, value: JSON.parse(text) as unknown };
}
