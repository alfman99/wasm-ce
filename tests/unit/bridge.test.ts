import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { bridgeNonce, bridgeProof } from '../../packages/protocol/src/index';
import { Bridge } from '../../packages/mcp-server/src/bridge';
import { isAuditKind } from '../../packages/mcp-server/src/audit';

const openBridges: Bridge[] = [];

afterEach(async () => {
  while (openBridges.length) await openBridges.pop()!.stop();
});

async function startBridge(token: string, reconnectGraceMs = 0): Promise<Bridge> {
  const bridge = new Bridge({ host: '127.0.0.1', port: 0, token, requestTimeoutMs: 500, reconnectGraceMs });
  await bridge.start();
  openBridges.push(bridge);
  return bridge;
}

/** The nonce each test socket was challenged with. */
const challenges = new WeakMap<WebSocket, string>();

/** Opens a socket the way the service worker does and waits for the server's challenge. */
function open(port: number, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, origin ? { origin } : {});
    socket.once('error', reject);
    socket.once('message', (raw) => {
      const message = JSON.parse(String(raw)) as { event?: string; data?: { nonce?: string } };
      if (message.event === 'bridge.challenge' && message.data?.nonce) challenges.set(socket, message.data.nonce);
      resolve(socket);
    });
  });
}

/** The extension's hello. Resolves with the welcome proof a server that holds `token` must send. */
async function hello(socket: WebSocket, token: string): Promise<string> {
  const serverNonce = challenges.get(socket) ?? '';
  const nonce = bridgeNonce();
  const proof = await bridgeProof(token, 'ext', serverNonce, nonce);
  socket.send(JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.hello', data: { extension: 'test', nonce, proof } }));
  return bridgeProof(token, 'srv', serverNonce, nonce);
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((done) => socket.once('close', (code) => done(code)));
}

describe('bridge token', () => {
  it('refuses a hello with the wrong token and never becomes usable', async () => {
    const bridge = await startBridge('right-token');
    const socket = await open(bridge.port);
    const closed = closeCode(socket);
    await hello(socket, 'wrong-token');

    expect(await closed).toBe(1008);
    // The socket was accepted at the transport level, yet the bridge remains unusable: that is the
    // whole point of authenticating before anything is dispatched.
    expect(bridge.connected).toBe(false);
    await expect(bridge.request('ext.ping')).rejects.toThrow(/not presented a valid bridge token|not connected/);
    await expect(bridge.waitForExtension(50)).rejects.toThrow(/no WasmCheat extension connected/);
    // The folder a person loads is the built one, not the package.
    await expect(bridge.waitForExtension(50)).rejects.toThrow(/Load packages\/extension\/dist as an unpacked extension/);
    socket.terminate();
  });

  it('refuses the token itself in place of a proof, and a hello with no challenge behind it', async () => {
    const bridge = await startBridge('right-token');
    const plain = await open(bridge.port);
    const plainClosed = closeCode(plain);
    plain.send(JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.hello', data: { token: 'right-token' } }));
    expect(await plainClosed).toBe(1008);

    // A proof is good for one hello: a second one on the same socket has no challenge left.
    const replay = await open(bridge.port);
    const replayClosed = closeCode(replay);
    await hello(replay, 'right-token');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);
    await hello(replay, 'right-token');
    expect(await replayClosed).toBe(1008);
  });

  it('accepts a proof of the right token and proves itself back', async () => {
    const bridge = await startBridge('right-token');
    const good = await open(bridge.port);
    const welcome = new Promise<{ proof?: string }>((done) => {
      good.once('message', (raw) => done((JSON.parse(String(raw)) as { data: { proof?: string } }).data));
    });
    const expected = await hello(good, 'right-token');
    expect((await welcome).proof).toBe(expected);
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);
    await expect(bridge.waitForExtension(500)).resolves.toBeUndefined();
    expect(bridge.version).toBe('test');
    good.terminate();
  });
});

describe('reconnect while a call is in flight', () => {
  it('waits for the extension to dial back in, then sends the request', async () => {
    // MV3 suspends the service worker constantly; the call that arrives just before it reconnects
    // must survive that gap instead of failing and making the setup look broken.
    const bridge = await startBridge('right-token', 4_000);
    const pending = bridge.request<{ ok: boolean }>('ext.ping');

    await new Promise((done) => setTimeout(done, 150));
    expect(bridge.connected).toBe(false);

    const socket = await open(bridge.port);
    // Answer the way the real service worker does, so this proves the round trip, not just the wait.
    answer(socket, { ok: true });
    await hello(socket, 'right-token');

    await expect(pending).resolves.toEqual({ ok: true });
    socket.terminate();
  });

  it('still fails quickly when no extension ever arrives', async () => {
    const bridge = await startBridge('right-token', 300);
    const started = Date.now();
    await expect(bridge.request('ext.ping')).rejects.toThrow(/not connected/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

async function pair(port: number): Promise<{ socket: WebSocket; reply: Promise<Record<string, unknown>> }> {
  const socket = await open(port);
  const reply = new Promise<Record<string, unknown>>((done) => {
    socket.once('message', (raw) => done(JSON.parse(String(raw)) as Record<string, unknown>));
  });
  socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'p1', method: 'bridge.pair', params: {} }));
  return { socket, reply };
}

describe('pairing', () => {
  it('hands the token to an extension that asks before anything is authenticated', async () => {
    const bridge = await startBridge('pair-me');
    const { socket, reply } = await pair(bridge.port);
    const answer = await reply;

    expect((answer.result as { token?: string }).token).toBe('pair-me');
    // Having the token is not the same as being trusted: the hello still has to present it.
    expect(bridge.connected).toBe(false);
    await hello(socket, 'pair-me');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);
    socket.close();
  });

  it('can be turned off, which leaves the token as the only way in', async () => {
    const bridge = new Bridge({ host: '127.0.0.1', port: 0, token: 'secret', pairing: false });
    await bridge.start();
    openBridges.push(bridge);

    const { socket, reply } = await pair(bridge.port);
    const answer = await reply;
    expect((answer.error as { message?: string }).message).toMatch(/pairing is disabled/);
    socket.close();
  });
});

describe('pairing again after a dropped socket', () => {
  it('offers the token to an extension that reconnects with no token saved', async () => {
    const bridge = await startBridge('re-pair');
    const first = await pair(bridge.port);
    await first.reply;
    await hello(first.socket, 're-pair');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);

    // The extension dropped its socket (a restart) and forgot the token: it must be able to ask again,
    // otherwise wiping a token would lock the human out of their own bridge for good.
    first.socket.close();
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(false);

    const second = await pair(bridge.port);
    const answer = await second.reply;
    expect((answer.result as { token?: string }).token).toBe('re-pair');
    second.socket.close();
  });
});

/** Answers every request with `result`, the way the service worker does. */
function answer(socket: WebSocket, result: unknown): void {
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as { kind: string; id: string };
    if (message.kind === 'req') socket.send(JSON.stringify({ v: 1, kind: 'res', id: message.id, result }));
  });
}

describe('a second connection cannot take over', () => {
  it('refuses pairing while the authenticated socket is live, and leaves it in place', async () => {
    const bridge = await startBridge('keep-me');
    const legit = await open(bridge.port);
    await hello(legit, 'keep-me');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);

    const intruder = await pair(bridge.port);
    const reply = await intruder.reply;
    expect(reply.result).toBeUndefined();
    expect((reply.error as { message?: string }).message).toMatch(/already paired/);
    expect(bridge.connected).toBe(true);
    answer(legit, 'from legit');
    await expect(bridge.request('ext.ping')).resolves.toBe('from legit');
    intruder.socket.close();
    legit.close();
  });

  it('refuses an upgrade from a web page origin, but not from the extension', async () => {
    const bridge = await startBridge('origin');
    await expect(open(bridge.port, 'https://evil.example')).rejects.toThrow(/401/);
    const extension = await open(bridge.port, 'chrome-extension://abcdefghijklmnop');
    extension.close();
  });
});

describe('every message is judged by the socket that sent it', () => {
  it('a bad hello closes only its own socket, and a good one authenticates only its own', async () => {
    const bridge = await startBridge('mine');
    const first = await open(bridge.port);
    const second = await open(bridge.port);
    const firstClosed = new Promise<number>((done) => first.once('close', (code) => done(code)));
    await hello(first, 'wrong');
    expect(await firstClosed).toBe(1008);

    await hello(second, 'mine');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);
    answer(second, 'from second');
    await expect(bridge.request('ext.ping')).resolves.toBe('from second');
    second.close();
  });

  it('ignores answers, events and audit lines from a socket that never authenticated', async () => {
    const bridge = await startBridge('trusted');
    const legit = await open(bridge.port);
    await hello(legit, 'trusted');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);

    const audits: unknown[] = [];
    bridge.on('action.audit', (data) => audits.push(data));
    const mirrored: unknown[] = [];
    const intruder = await open(bridge.port);
    intruder.on('message', (raw) => mirrored.push(JSON.parse(String(raw))));

    // The legit socket stays silent, so a forged answer is the only one the request could get.
    const pending = bridge.request('ext.listTabs').catch((error: Error) => error.message);
    await new Promise((done) => setTimeout(done, 20));
    intruder.send(JSON.stringify({ v: 1, kind: 'res', id: 'r1', result: [{ tabId: 666 }] }));
    intruder.send(JSON.stringify({ v: 1, kind: 'evt', event: 'action.audit', data: { kind: 'write', summary: 'forged' } }));
    bridge.send('audit.appended', { summary: 'secret' });

    expect(await pending).toMatch(/timed out/);
    expect(audits).toEqual([]);
    expect(mirrored).toEqual([]);
    intruder.close();
    legit.close();
  });

  it('only accepts audit kinds the log knows', () => {
    expect(isAuditKind('write')).toBe(true);
    expect(isAuditKind('rm -rf')).toBe(false);
    expect(isAuditKind('toString')).toBe(false);
  });
});

describe('a replaced or half-open socket', () => {
  it('fails a request sent on the replaced socket at once instead of at the timeout', async () => {
    const bridge = new Bridge({ host: '127.0.0.1', port: 0, token: 'swap', requestTimeoutMs: 10_000 });
    await bridge.start();
    openBridges.push(bridge);
    const old = await open(bridge.port);
    await hello(old, 'swap');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);

    const started = Date.now();
    const pending = bridge.request('ext.ping').catch((error: { code?: string }) => error.code);
    const fresh = await open(bridge.port);
    await hello(fresh, 'swap');
    expect(await pending).toBe('NO_AGENT');
    expect(Date.now() - started).toBeLessThan(2_000);
    fresh.close();
  });

  it('waits out the grace for a socket that is open but has not said hello yet', async () => {
    const bridge = await startBridge('late-hello', 4_000);
    const socket = await open(bridge.port);
    answer(socket, { ok: true });
    const pending = bridge.request('ext.ping');
    await new Promise((done) => setTimeout(done, 150));
    await hello(socket, 'late-hello');
    await expect(pending).resolves.toEqual({ ok: true });
    socket.close();
  });
});

/**
 * Loads the real service worker against a stand-in `chrome`: storage reads `store`, listeners are
 * collected so a test can fire them, every call is logged in `calls`, and the rest resolve to `{}`.
 */
const calls: string[] = [];
const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
async function loadServiceWorker(store: Record<string, unknown>): Promise<void> {
  const stub = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => (key === 'then' ? undefined : stub(`${path}.${String(key)}`)),
      apply: (_target, _this, args: unknown[]) => {
        calls.push(path);
        if (path === 'chrome.storage.local.get') return Promise.resolve({ ...store });
        if (path === 'chrome.storage.local.set') return Promise.resolve(Object.assign(store, args[0]));
        if (path === 'chrome.runtime.getManifest') return { version: 'test' };
        if (path.endsWith('.addListener')) return void (listeners[path] ??= []).push(args[0] as () => void);
        return Promise.resolve({});
      },
    });
  vi.stubGlobal('chrome', stub('chrome'));
  vi.resetModules();
  await import('../../packages/extension/src/sw');
}

describe('the extension checks the server before trusting it', () => {
  // One service worker for the whole block, as in the browser: the impostor is met first, then the
  // real bridge comes up, the way a human would fix it.
  const store: Record<string, unknown> = { bridgeToken: 'real-secret', bridgeTokenSource: 'pasted' };

  it('an impostor server never receives the token, and gets no answer before or after a bad proof', async () => {
    const impostor = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((done) => impostor.once('listening', done));
    store.wasmcheatPort = (impostor.address() as { port: number }).port;
    const heard: string[] = [];
    const closed = new Promise<void>((resolve) => {
      impostor.on('connection', (socket) => {
        socket.on('message', (raw) => {
          heard.push(String(raw));
          // Ask for the tabs at once: no proof has been sent yet.
          socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'early', method: 'ext.listTabs', params: {} }));
          // And let a page report something: it must not reach a server that has not proved itself.
          for (const listener of listeners['chrome.runtime.onMessage.addListener'] ?? []) {
            listener({ type: 'wasmcheat.event', event: 'watch.hit', data: {} }, { tab: { id: 7 } }, () => undefined);
          }
        });
        socket.on('close', () => resolve());
        socket.send(JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.challenge', data: { nonce: bridgeNonce() } }));
        setTimeout(() => {
          // A forged welcome, then a request behind it: the extension must hang up instead.
          socket.send(JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.welcome', data: { proof: '0'.repeat(64) } }));
          socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'late', method: 'ext.listTabs', params: {} }));
        }, 300);
      });
    });

    await loadServiceWorker(store);
    await closed;
    impostor.close();

    expect(heard).toHaveLength(1);
    const helloMessage = JSON.parse(heard[0]!) as { event: string; data: Record<string, unknown> };
    expect(helloMessage.event).toBe('bridge.hello');
    expect(helloMessage.data.proof).toMatch(/^[0-9a-f]{64}$/);
    expect(heard.join('')).not.toContain('real-secret');
    // Not answered, and not run either: listing tabs would have asked Chrome for them.
    expect(calls.filter((path) => path.startsWith('chrome.tabs.') && !path.endsWith('.addListener'))).toEqual([]);
  });

  it('pairs with the real bridge, checks its proof and only then answers', async () => {
    const bridge = await startBridge('real-secret', 4_000);
    store.wasmcheatPort = bridge.port;
    delete store.bridgeToken;
    // A changed token is what reconnects at once, the way the panel's token field does.
    for (const listener of listeners['chrome.storage.onChanged.addListener'] ?? []) {
      listener({ bridgeToken: { newValue: undefined } }, 'local');
    }

    const ping = await bridge.request<{ ok: boolean; bridgeConnected: boolean; tokenSource: string }>('ext.ping');
    expect(ping).toMatchObject({ ok: true, bridgeConnected: true, tokenSource: 'paired' });
    expect(store.bridgeToken).toBe('real-secret');
  });
});
