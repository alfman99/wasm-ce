import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Bridge } from '../../packages/mcp-server/src/bridge';

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

function connect(port: number, token: string): Promise<{ socket: WebSocket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    const closed = new Promise<number>((done) => socket.once('close', (code) => done(code)));
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(
        JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.hello', data: { extension: 'test', token } }),
      );
      resolve({ socket, closed });
    });
  });
}

describe('bridge token', () => {
  it('refuses a hello with the wrong token and never becomes usable', async () => {
    const bridge = await startBridge('right-token');
    const { socket, closed } = await connect(bridge.port, 'wrong-token');

    expect(await closed).toBe(1008);
    // The socket was accepted at the transport level, yet the bridge remains unusable: that is the
    // whole point of authenticating before anything is dispatched.
    expect(bridge.connected).toBe(false);
    await expect(bridge.request('ext.ping')).rejects.toThrow(/not presented a valid bridge token|not connected/);
    await expect(bridge.waitForExtension(50)).rejects.toThrow(/no WasmCheat extension connected/);
    socket.terminate();
  });

  it('accepts the right token and rejects a connection with none at all', async () => {
    const bridge = await startBridge('right-token');
    const anonymous = await connect(bridge.port, '');
    expect(await anonymous.closed).toBe(1008);
    anonymous.socket.terminate();

    const good = await connect(bridge.port, 'right-token');
    await expect.poll(() => bridge.connected, { timeout: 2_000 }).toBe(true);
    await expect(bridge.waitForExtension(500)).resolves.toBeUndefined();
    expect(bridge.version).toBe('test');
    good.socket.terminate();
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

    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`);
    socket.on('open', () => {
      socket.send(
        JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.hello', data: { extension: 'test', token: 'right-token' } }),
      );
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { kind: string; id: string };
      if (message.kind !== 'req') return;
      // Answer the way the real service worker does, so this proves the round trip, not just the wait.
      socket.send(JSON.stringify({ v: 1, kind: 'res', id: message.id, result: { ok: true } }));
    });

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

function pair(port: number): Promise<{ socket: WebSocket; reply: Promise<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
      const reply = new Promise<Record<string, unknown>>((done) => {
        socket.once('message', (raw) => done(JSON.parse(String(raw)) as Record<string, unknown>));
      });
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'p1', method: 'bridge.pair', params: {} }));
        resolve({ socket, reply });
      });
    });
}

describe('pairing', () => {
  

  it('hands the token to an extension that asks before anything is authenticated', async () => {
    const bridge = await startBridge('pair-me');
    const { socket, reply } = await pair(bridge.port);
    const answer = await reply;

    expect((answer.result as { token?: string }).token).toBe('pair-me');
    // Having the token is not the same as being trusted: the hello still has to present it.
    expect(bridge.connected).toBe(false);
    socket.send(
      JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.hello', data: { extension: 'test', token: 'pair-me' } }),
    );
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
    first.socket.send(
      JSON.stringify({ v: 1, kind: 'evt', event: 'bridge.hello', data: { extension: 'test', token: 're-pair' } }),
    );
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
