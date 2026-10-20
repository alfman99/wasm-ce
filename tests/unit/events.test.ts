import { describe, expect, it } from 'vitest';
import { BridgeError } from '@wasmcheat/protocol';
import { waitForPageEvent } from '../../packages/mcp-server/src/events';

/**
 * Stands in for the WebSocket bridge: the same `on(event, listener): unsubscribe` contract, but
 * driven from the test instead of from a socket.
 */
class FakeBridge {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, listener: (data: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(event: string, data: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }

  count(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const HIT = { kind: 'write', funcIndex: 3, funcName: 'mine', address: 'w1:0x408', previous: 0, value: 25, at: 1 };

describe('waitForPageEvent', () => {
  it('resolves with the payload of the first matching event and unsubscribes', async () => {
    const bridge = new FakeBridge();
    const waiting = waitForPageEvent(bridge, 7, 'trace.hit', { timeoutMs: 5_000 });
    expect(bridge.count('page.event')).toBe(1);

    bridge.emit('page.event', { tabId: 7, frameId: 0, event: 'trace.hit', data: HIT });

    await expect(waiting).resolves.toEqual(HIT);
    expect(bridge.count('page.event')).toBe(0);
  });

  it('ignores another tab and another event name on the same channel', async () => {
    const bridge = new FakeBridge();
    const waiting = waitForPageEvent(bridge, 7, 'trace.hit', { timeoutMs: 5_000 });

    bridge.emit('page.event', { tabId: 9, frameId: 0, event: 'trace.hit', data: { tabId: 9 } });
    bridge.emit('page.event', { tabId: 7, frameId: 0, event: 'other.event', data: { wrong: true } });
    bridge.emit('page.event', { tabId: 7, frameId: 0, event: 'trace.hit', data: HIT });

    await expect(waiting).resolves.toEqual(HIT);
  });

  it('rejects with TIMEOUT when nothing arrives inside the bound, and stops listening', async () => {
    const bridge = new FakeBridge();
    const waiting = waitForPageEvent(bridge, 7, 'trace.hit', { timeoutMs: 5 });

    await expect(waiting).rejects.toThrow(/no "trace.hit" event from tab 7/);
    await expect(waiting).rejects.toBeInstanceOf(BridgeError);
    expect(bridge.count('page.event')).toBe(0);
  });
});


