import { BridgeError, Events, type ApprovalState } from '@wasmcheat/protocol';
import type { Bridge } from './bridge.js';

/**
 * Waiting on the bridge means subscribing to the event that ends the wait, never asking
 * "has it happened yet?" on a timer: the extension already pushes both of these. The timeout is a
 * safety bound so a call cannot hang forever, not the mechanism.
 */

/** The only part of the bridge these waits need, so a test can stand in for a socket. */
type EventSource = Pick<Bridge, 'on'>;

/** What `sw.ts` puts on `page.event` for every page agent event it relays. */
export interface PageEventPayload {
  tabId: number;
  frameId: number;
  event: string;
  data: unknown;
}

/**
 * Resolves with the payload of the first `eventName` event from `tabId`, or rejects with
 * `TIMEOUT` once `timeoutMs` has passed without one. Other tabs and other event names share the
 * channel, so everything that does not match is ignored.
 */
export function waitForPageEvent(
  bridge: EventSource,
  tabId: number,
  eventName: string,
  options: { timeoutMs: number },
): Promise<unknown> {
  const timeoutMs = Math.max(0, options.timeoutMs);
  return new Promise<unknown>((resolve, reject) => {
    let unsubscribe = (): void => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new BridgeError('TIMEOUT', `no "${eventName}" event from tab ${tabId} within ${timeoutMs}ms`, {
          tabId,
          event: eventName,
        }),
      );
    }, timeoutMs);
    unsubscribe = bridge.on(Events.pageEvent, (payload) => {
      const pageEvent = payload as Partial<PageEventPayload> | null;
      if (!pageEvent || pageEvent.tabId !== tabId || pageEvent.event !== eventName) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(pageEvent.data);
    });
  });
}

/**
 * Resolves with the state the human (or a navigation, or a revoke) settled the request on.
 *
 * Rejects with `APPROVAL_TIMEOUT` when nobody answered inside the bound; the caller decides what
 * an unanswered request means, this helper does not.
 */
export function waitForApproval(
  bridge: EventSource,
  tabId: number,
  options: { timeoutMs: number },
): Promise<ApprovalState> {
  const timeoutMs = Math.max(0, options.timeoutMs);
  return new Promise<ApprovalState>((resolve, reject) => {
    let unsubscribe = (): void => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new BridgeError('APPROVAL_TIMEOUT', `nobody answered the approval request for tab ${tabId} within ${timeoutMs}ms`, {
          tabId,
        }),
      );
    }, timeoutMs);
    unsubscribe = bridge.on(Events.approvalResolved, (payload) => {
      const resolved = payload as { tabId?: number; state?: ApprovalState } | null;
      if (!resolved || resolved.tabId !== tabId) return;
      clearTimeout(timer);
      unsubscribe();
      // A resolved event always carries a state; an empty one means "not granted", which is what
      // an absent state has always meant for the caller.
      resolve(resolved.state ?? 'pending');
    });
  });
}
