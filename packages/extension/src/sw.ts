import {
  BridgeError,
  Events,
  PROTOCOL_VERSION,
  isRequest,
  makeErrorResponse,
  makeResponse,
  type ApprovalState,
  type PageAgentInfo,
  type PageDiagnostics,
  type TabInfo,
} from '@wasmcheat/protocol';

/**
 * Service worker: the only part of the extension that talks to the MCP server.
 *
 * It owns the approval gate. Every page-level call funnels through `callTab`, which refuses
 * to forward anything for a tab the human has not approved. Approval state lives in
 * `chrome.storage.session` because MV3 kills this worker whenever it likes.
 */

// Injected by build.mjs from WASMCHEAT_PORT so the extension and the MCP server agree
// without a settings UI: rebuild the extension with the same port the server listens on.
declare const __BRIDGE_PORT__: number;
const BRIDGE_PORT: number = typeof __BRIDGE_PORT__ === 'number' ? __BRIDGE_PORT__ : 7331;
const DEFAULT_BRIDGE_PORT = 7331;

/**
 * The port lives in storage so a test run (or a second server) can point the extension elsewhere
 * without a rebuild: two extensions dialling one port cross-talk, and an e2e suite that shares 7331
 * with the human's browser ends up reading the human's tabs.
 */
async function bridgeUrl(): Promise<string> {
  const stored = await chrome.storage.local.get('wasmcheatPort');
  const configured = Number(stored.wasmcheatPort ?? BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
  const port = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BRIDGE_PORT;
  return `ws://127.0.0.1:${port}/extension`;
}
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;
const APPROVAL_POLL_MS = 400;
/**
 * MV3 terminates an idle service worker after 30s, and a wait on a human click is exactly that:
 * timers do not count as activity, so a long approval wait would die mid-poll and the bridge would
 * time out. Pinging a trivial extension API every 15s keeps the worker alive while we wait.
 */
const KEEPALIVE_MS = 15_000;

interface ApprovalEntry {
  state: ApprovalState;
  reason: string;
  requestId: string;
  at: number;
  tabTitle?: string;
  tabUrl?: string;
}

type Approvals = Record<string, ApprovalEntry>;

let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const attachedTabs = new Set<number>();
/** tabId → frameId → url, filled from relay announcements (one per frame). */
const tabFrames = new Map<number, Map<number, string>>();
/** tabId → the frame that owns the wasm, so page.* calls land in the right realm. */
const activeFrame = new Map<number, number>();
/** tabId → the grant that should survive the reload we are about to cause ourselves. */
const keepApprovalOnReload = new Map<number, ApprovalEntry>();
/**
 * tabId → a watchpoint that must be re-armed in the next document.
 *
 * A watchpoint only exists if it is in place before the app compiles its module, so the intent
 * has to outlive the reload that creates that document. The relay announces itself at
 * document_start, which is where we put it back.
 */
const pendingTraces = new Map<number, { address: string; type?: string; maxHits?: number; kind?: string }>();

/**
 * Everything above is in memory, which an MV3 worker loses whenever Chrome suspends it — and a
 * suspension costs the human a re-attach and the agent a scan session. So the routing state
 * (which frames exist, which one owns the wasm, what watchpoint is pending) is mirrored into
 * `chrome.storage.session`: same trust level as the grant table, gone when the browser closes.
 */
const SESSION_KEY = 'wasmcheat.session';
interface SessionState {
  attached: number[];
  frames: Record<string, Record<string, string>>;
  activeFrame: Record<string, number>;
  traces: Record<string, { address: string; type?: string; maxHits?: number; kind?: string }>;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistSession(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const state: SessionState = {
      attached: [...attachedTabs],
      frames: Object.fromEntries(
        [...tabFrames].map(([tabId, frames]) => [String(tabId), Object.fromEntries(frames)]),
      ),
      activeFrame: Object.fromEntries(activeFrame),
      traces: Object.fromEntries(pendingTraces),
    };
    void chrome.storage.session.set({ [SESSION_KEY]: state }).catch(() => undefined);
  }, 100);
}

async function restoreSession(): Promise<void> {
  try {
    const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as SessionState | undefined;
    if (!stored) return;
    for (const tabId of stored.attached ?? []) attachedTabs.add(tabId);
    for (const [tabId, frames] of Object.entries(stored.frames ?? {})) {
      tabFrames.set(Number(tabId), new Map(Object.entries(frames).map(([id, url]) => [Number(id), url])));
    }
    for (const [tabId, frameId] of Object.entries(stored.activeFrame ?? {})) activeFrame.set(Number(tabId), frameId);
    for (const [tabId, trace] of Object.entries(stored.traces ?? {})) pendingTraces.set(Number(tabId), trace);
  } catch {
    // A fresh window has no session state; nothing to restore.
  }
}
void restoreSession();

// ---------------------------------------------------------------- storage

async function readApprovals(): Promise<Approvals> {
  const stored = await chrome.storage.session.get('approvals');
  return (stored.approvals as Approvals | undefined) ?? {};
}

async function writeApprovals(approvals: Approvals): Promise<void> {
  await chrome.storage.session.set({ approvals });
  await refreshBadge(approvals);
}

async function setApproval(tabId: number, entry: ApprovalEntry | null): Promise<void> {
  const approvals = await readApprovals();
  if (entry) approvals[String(tabId)] = entry;
  else delete approvals[String(tabId)];
  await writeApprovals(approvals);
}

async function refreshBadge(approvals?: Approvals): Promise<void> {
  const current = approvals ?? (await readApprovals());
  const pending = Object.values(current).filter((entry) => entry.state === 'pending').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#e8590c' });
  await chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' });
}

// ---------------------------------------------------------------- bridge socket

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(await bridgeUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectDelay = RECONNECT_BASE_MS;
    send({
      v: PROTOCOL_VERSION,
      kind: 'evt',
      event: 'bridge.hello',
      data: { extension: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION },
    });
  });

  socket.addEventListener('message', (event) => {
    void onBridgeMessage(event.data);
  });

  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    socket?.close();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

function send(payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function emit(event: string, data: unknown): void {
  send({ v: PROTOCOL_VERSION, kind: 'evt', event, data });
}

async function onBridgeMessage(raw: unknown): Promise<void> {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  if (!isRequest(parsed)) return;

  try {
    const result = await handleBridgeRequest(parsed.method, parsed.params);
    send(makeResponse(parsed.id, result));
  } catch (error) {
    send(makeErrorResponse(parsed.id, error));
  }
}

async function handleBridgeRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'ext.ping':
      return { ok: true, extension: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION };
    case 'ext.listTabs':
      return listTabs();
    case 'ext.requestApproval':
      return requestApproval(params as { tabId: number; reason?: string; waitMs?: number });
    case 'ext.approvalStatus':
      return approvalStatus(params as { tabId: number });
    case 'ext.revoke':
      return revoke(params as { tabId: number; reason?: string });
    case 'ext.ensureAgent':
      return ensureAgent(params as { tabId: number; reload?: boolean });
    case 'ext.call':
      return callTab(params as { tabId: number; method: string; params?: unknown; timeoutMs?: number });
    case 'ext.detach':
      return revoke(params as { tabId: number; reason?: string });
    case 'ext.reload':
      return reloadTab(params as { tabId: number });
    case 'ext.traceArm':
      return traceArm(params as { tabId: number; address: string; type?: string; maxHits?: number; kind?: string });
    default:
      throw new BridgeError('BAD_PARAMS', `unknown extension method "${method}"`);
  }
}

// ---------------------------------------------------------------- tabs

async function listTabs(): Promise<TabInfo[]> {
  const approvals = await readApprovals();
  const tabs = await chrome.tabs.query({});
  const visible: TabInfo[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const url = tab.url ?? tab.pendingUrl ?? '';
    if (!/^https?:\/\//.test(url)) continue;
    visible.push({
      tabId: tab.id,
      windowId: tab.windowId ?? -1,
      title: tab.title ?? '',
      url,
      active: tab.active ?? false,
      agentAttached: attachedTabs.has(tab.id),
      approval: approvals[String(tab.id)]?.state ?? 'none',
      frames: [...(tabFrames.get(tab.id) ?? new Map<number, string>()).entries()].map(([frameId, url]) => ({
        frameId,
        url,
      })),
    });
  }
  return visible.sort((a, b) => Number(b.active) - Number(a.active) || a.tabId - b.tabId);
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new BridgeError('NO_TAB', `no tab with id ${tabId}`);
  }
}

// ---------------------------------------------------------------- approval

async function requestApproval(params: { tabId: number; reason?: string; waitMs?: number }): Promise<{
  requestId: string;
  state: ApprovalState;
  tab?: { title: string; url: string };
}> {
  const tab = await getTab(params.tabId);

  // An already-approved tab must not be re-prompted: re-attaching is a normal thing for an
  // agent to do, and flashing the human a second dialog for the same tab is noise.
  const existing = (await readApprovals())[String(params.tabId)];
  if (existing?.state === 'granted') {
    return {
      requestId: existing.requestId,
      state: 'granted',
      tab: { title: existing.tabTitle ?? tab.title ?? '', url: existing.tabUrl ?? tab.url ?? '' },
    };
  }

  const requestId = crypto.randomUUID();
  const reason = params.reason?.trim() || 'An agent wants to read and modify this page\'s WebAssembly memory.';
  const entry: ApprovalEntry = {
    state: 'pending',
    reason,
    requestId,
    at: Date.now(),
    tabTitle: tab.title ?? '',
    tabUrl: tab.url ?? '',
  };
  await setApproval(params.tabId, entry);
  emit(Events.approvalRequested, { tabId: params.tabId, requestId, reason, title: entry.tabTitle, url: entry.tabUrl });

  const waitMs = Math.max(0, Math.min(params.waitMs ?? 0, 120_000));
  const tabInfo = { title: entry.tabTitle ?? '', url: entry.tabUrl ?? '' };
  if (waitMs === 0) return { requestId, state: 'pending', tab: tabInfo };

  const deadline = Date.now() + waitMs;
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, KEEPALIVE_MS);
  try {
    while (Date.now() < deadline) {
      await sleep(APPROVAL_POLL_MS);
      const approvals = await readApprovals();
      const current = approvals[String(params.tabId)];
      if (!current || current.requestId !== requestId) {
        return { requestId, state: current?.state ?? 'revoked', tab: tabInfo };
      }
      if (current.state !== 'pending') return { requestId, state: current.state, tab: tabInfo };
    }
  } finally {
    clearInterval(keepAlive);
  }
  return { requestId, state: 'pending', tab: tabInfo };
}

async function approvalStatus(params: { tabId: number }): Promise<ApprovalEntry | null> {
  const approvals = await readApprovals();
  return approvals[String(params.tabId)] ?? null;
}

async function revoke(params: { tabId: number; reason?: string }): Promise<{ ok: true }> {
  await setApproval(params.tabId, {
    state: 'revoked',
    reason: params.reason ?? 'revoked by the user or the agent',
    requestId: '',
    at: Date.now(),
  });
  emit(Events.approvalResolved, { tabId: params.tabId, state: 'revoked' });
  return { ok: true };
}

// ---------------------------------------------------------------- page calls

/**
 * Reloads a tab that is already approved, keeping the grant.
 *
 * A write watchpoint has to be in place before the app compiles its module, so tracing a page
 * that is already running means reloading it. A navigation normally revokes approval, but this
 * reload is ours and lands on the same URL, so the grant carries over instead of asking the
 * human a second time for the same page.
 */
async function reloadTab(params: { tabId: number }): Promise<{ reloaded: true }> {
  const approvals = await readApprovals();
  const entry = approvals[String(params.tabId)];
  if (!entry || entry.state !== 'granted') {
    throw new BridgeError('NEED_APPROVAL', `tab ${params.tabId} is not approved`);
  }
  keepApprovalOnReload.set(params.tabId, entry);
  attachedTabs.delete(params.tabId);
  await chrome.tabs.reload(params.tabId);
  const ready = await waitFor(() => attachedTabs.has(params.tabId), 15_000);
  if (!ready) {
    throw new BridgeError('NO_AGENT', `tab ${params.tabId} did not re-attach after reload`);
  }
  activeFrame.delete(params.tabId);
  return { reloaded: true };
}

/** Arms a write watchpoint now and remembers it for the next document of that tab. */
async function traceArm(params: {
  tabId: number;
  address: string;
  type?: string;
  maxHits?: number;
  kind?: string;
}): Promise<unknown> {
  const options = {
    address: params.address,
    ...(params.type ? { type: params.type } : {}),
    ...(params.maxHits ? { maxHits: params.maxHits } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  };
  pendingTraces.set(params.tabId, options);
  persistSession();
  const frameId = await resolveFrame(params.tabId);
  return sendToTab(params.tabId, 'page.trace.arm', options, 8_000, frameId);
}

async function ensureAgent(params: { tabId: number; reload?: boolean; frameId?: number }): Promise<PageAgentInfo> {
  const tab = await getTab(params.tabId);
  if (params.reload) {
    await chrome.tabs.reload(params.tabId);
    const ready = await waitFor(() => attachedTabs.has(params.tabId), 15_000);
    if (!ready) {
      throw new BridgeError('NO_AGENT', `tab ${params.tabId} did not re-attach after reload`);
    }
  } else if (!attachedTabs.has(params.tabId)) {
    await injectAgent(params.tabId);
  }

  // Re-resolve every attach: a reloaded page may instantiate its wasm somewhere else.
  activeFrame.delete(params.tabId);
  if (params.frameId !== undefined) {
    activeFrame.set(params.tabId, params.frameId);
    persistSession();
  }
  const frameId = params.frameId ?? (await resolveFrame(params.tabId));
  const info = await sendToTab<PageAgentInfo>(params.tabId, 'page.hello', {}, 8_000, frameId);
  return frameId === undefined ? info : { ...info, frameId };
}

/**
 * Which frame holds the wasm? Games usually live in a cross-origin subframe, and a content
 * script in the top frame cannot see into it. Ask every frame we know about and pick the one
 * that actually captured an instance; fall back to the frame with the most instances.
 */
async function resolveFrame(tabId: number): Promise<number | undefined> {
  const cached = activeFrame.get(tabId);
  if (cached !== undefined) return cached;

  const frames = tabFrames.get(tabId);
  if (!frames || frames.size === 0) return undefined;
  if (frames.size === 1) {
    const [only] = [...frames.keys()];
    if (only !== undefined) activeFrame.set(tabId, only);
    return only;
  }

  let best: { frameId: number; instances: number } | null = null;
  for (const [frameId, url] of frames) {
    if (!/^https?:/i.test(url)) continue;
    try {
      const info = await sendToTab<PageDiagnostics>(tabId, 'page.diagnose', {}, 4_000, frameId);
      if (!best || info.instances > best.instances) best = { frameId, instances: info.instances };
    } catch {
      // Frame raced away or has no relay; ignore it.
    }
  }
  if (best) activeFrame.set(tabId, best.frameId);
  return best?.frameId;
}

async function injectAgent(tabId: number): Promise<void> {
  await getTab(tabId);
  try {
    // allFrames matters: the app often lives in a cross-origin iframe (YouTube Playables,
    // itch.io embeds, Unity WebGL wrappers), which the top frame cannot reach into.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      files: ['relay.js'],
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['page-agent.js'],
    });
  } catch (error) {
    throw new BridgeError(
      'NO_AGENT',
      `cannot inject into tab ${tabId}: ${(error as Error).message}. ` +
        'Chrome refuses extension scripts on chrome:// pages, the Web Store and PDFs.',
    );
  }
}

async function callTab(params: {
  tabId: number;
  method: string;
  params?: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  if (typeof params.method !== 'string' || !params.method.startsWith('page.')) {
    throw new BridgeError('BAD_PARAMS', `ext.call only forwards page.* methods, got "${params.method}"`);
  }
  const approvals = await readApprovals();
  const approval = approvals[String(params.tabId)];
  if (!approval || approval.state !== 'granted') {
    throw new BridgeError(
      'NEED_APPROVAL',
      approval?.state === 'pending'
        ? `tab ${params.tabId} is waiting for the human to approve the request`
        : `tab ${params.tabId} has not been approved (state: ${approval?.state ?? 'none'})`,
      { tabId: params.tabId, state: approval?.state ?? 'none', requestId: approval?.requestId ?? null },
    );
  }

  const timeoutMs = Math.max(1_000, Math.min(params.timeoutMs ?? RPC_TIMEOUT_MS, 120_000));
  const frameId = await resolveFrame(params.tabId);
  try {
    return await sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, frameId);
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== 'NO_AGENT') throw error;
    await injectAgent(params.tabId);
    attachedTabs.add(params.tabId);
    const retryId = frameId ?? (await resolveFrame(params.tabId));
    return sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, retryId);
  }
}

async function sendToTab<T>(
  tabId: number,
  method: string,
  params: unknown,
  timeoutMs: number,
  frameId?: number,
): Promise<T> {
  let response: unknown;
  try {
    const message = { type: 'wasmcheat.rpc', method, params };
    response = await withTimeout(
      frameId === undefined ? chrome.tabs.sendMessage(tabId, message) : chrome.tabs.sendMessage(tabId, message, { frameId }),
      timeoutMs,
      method,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Receiving end does not exist|Could not establish connection|No frame with id/i.test(message)) {
      throw new BridgeError('NO_AGENT', `no WasmCheat relay in tab ${tabId}; the page needs a reload`);
    }
    throw error;
  }

  const payload = response as { result?: unknown; error?: { code?: string; message?: string } } | undefined;
  if (!payload) throw new BridgeError('NO_AGENT', `tab ${tabId} answered ${method} with nothing`);
  if (payload.error) {
    throw new BridgeError((payload.error.code ?? 'INTERNAL') as never, payload.error.message ?? 'page error');
  }
  return payload.result as T;
}

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeError('TIMEOUT', `${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

// ---------------------------------------------------------------- popup + lifecycle

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (value: unknown) => void) => {
  const msg = message as { type?: string; tabId?: number; channelId?: string; url?: string } | null;
  if (!msg?.type) return undefined;

  if (msg.type === 'wasmcheat.relay-ready') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      attachedTabs.add(tabId);
      const frameId = sender.frameId ?? 0;
      let frames = tabFrames.get(tabId);
      if (!frames) tabFrames.set(tabId, (frames = new Map()));
      const url = (msg as { url?: string }).url ?? sender.url ?? '';
      if (!frames.has(frameId) || frames.get(frameId) !== url) {
        frames.set(frameId, url);
        persistSession();
        emit(Events.tabsChanged, { tabId, attached: true, frameId });
      }
      const trace = pendingTraces.get(tabId);
      if (trace) {
        // Best effort and deliberately fire-and-forget: the page may still instantiate first,
        // and the trace status reports that honestly.
        void sendToTab(tabId, 'page.trace.arm', trace, 5_000, frameId).catch(() => undefined);
      }
    }
    return undefined;
  }

  if (msg.type === 'popup.state') {
    void (async () => {
      sendResponse({
        approvals: await readApprovals(),
        tabs: await listTabs(),
        bridgeConnected: socket?.readyState === WebSocket.OPEN,
      });
    })();
    return true;
  }

  if (msg.type === 'popup.approve' && typeof msg.tabId === 'number') {
    const approvedTabId = msg.tabId;
    void (async () => {
      const approvals = await readApprovals();
      const pending = approvals[String(approvedTabId)];
      await setApproval(approvedTabId, {
        state: 'granted',
        reason: pending?.reason ?? 'approved in the popup',
        requestId: pending?.requestId ?? crypto.randomUUID(),
        at: Date.now(),
        tabTitle: pending?.tabTitle,
        tabUrl: pending?.tabUrl,
      });
      emit(Events.approvalResolved, { tabId: approvedTabId, state: 'granted' });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'popup.deny' && typeof msg.tabId === 'number') {
    const deniedTabId = msg.tabId;
    void (async () => {
      await revoke({ tabId: deniedTabId, reason: 'denied in the popup' });
      sendResponse({ ok: true });
    })();
    return true;
  }

  return undefined;
});

/** Two URLs on the same origin count as the same site; a missing URL is never a match. */
function sameSite(before: string | undefined, after: string | undefined): boolean {
  if (!before || !after) return false;
  try {
    return new URL(before).origin === new URL(after).origin;
  } catch {
    return before === after;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabFrames.delete(tabId);
  activeFrame.delete(tabId);
  pendingTraces.delete(tabId);
  persistSession();
  void (async () => {
    const approvals = await readApprovals();
    if (approvals[String(tabId)]) {
      delete approvals[String(tabId)];
      await writeApprovals(approvals);
    }
  })();
});

// A navigation invalidates the approval: the new page is not the one the human vetted.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const kept = keepApprovalOnReload.get(tabId);
    keepApprovalOnReload.delete(tabId);
    attachedTabs.delete(tabId);
    tabFrames.delete(tabId);
    activeFrame.delete(tabId);
    persistSession();
    // A grant is scoped to the tab and the site, not to one URL: games navigate (a level select, a
    // hash route, a reload we caused ourselves) and re-prompting for every step would train the
    // human to approve without reading. Leaving the site still revokes.
    if (kept && kept.state === 'granted' && sameSite(kept.tabUrl, changeInfo.url)) return;
    void (async () => {
      const approvals = await readApprovals();
      const entry = approvals[String(tabId)];
      if (entry && entry.state === 'granted' && sameSite(entry.tabUrl, changeInfo.url)) {
        attachedTabs.delete(tabId);
        return;
      }
      if (entry) {
        delete approvals[String(tabId)];
        await writeApprovals(approvals);
        emit(Events.approvalResolved, { tabId, state: 'none', reason: 'tab navigated' });
      }
    })();
  }
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => {
  connect();
  void refreshBadge();
});

// Keep trying to reach the local bridge for as long as the worker is alive.
connect();
chrome.alarms?.create?.('wasmcheat-bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm.name === 'wasmcheat-bridge-keepalive') void connect();
});
