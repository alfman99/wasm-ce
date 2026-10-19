import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Bridge } from '../../packages/mcp-server/src/bridge';

const openBridges: Bridge[] = [];

afterEach(async () => {
  while (openBridges.length) await openBridges.pop()!.stop();
});

async function startBridge(token: string): Promise<Bridge> {
  const bridge = new Bridge({ host: '127.0.0.1', port: 0, token, requestTimeoutMs: 500 });
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
