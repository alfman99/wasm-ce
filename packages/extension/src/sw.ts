import {
  BRIDGE_PAIR,
  BridgeError,
  Events,
  PROTOCOL_VERSION,
  isEvent,
  isRequest,
  isResponse,
  makeErrorResponse,
  makeResponse,
  type ApprovalState,
  type BridgeErrorShape,
  type PageAgentInfo,
  type PageDiagnostics,
  type TabInfo,
  formatAddress,
  type ValueType,
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
/** A frame that has not answered hello in this long is treated as gone, not as slow. */
const FRAME_PROBE_TIMEOUT_MS = 1_500;
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
 * Sites the human said "always allow". Keyed by origin, stored in `localStorage` rather than
 * `sessionStorage` because the whole point is that it survives a browser restart: approving the
 * same game every morning is the friction this exists to remove.
 */
interface TrustedSite {
  origin: string;
  at: number;
  label: string;
}

type TrustedSites = Record<string, TrustedSite>;

const TRUSTED_KEY = 'trustedSites';

/**
 * The tab the popup should put first. In Chrome, opening the popup does not change the active tab, so
 * the plain query is right — but any harness (and a DevTools panel tab) makes an extension page the
 * active one, and then the honest answer is the page you were last on.
 */
async function pickActiveTab(): Promise<number | null> {
  const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (front?.id !== undefined && originOf(front.url)) return front.id;
  const windowTabs = await chrome.tabs.query({ currentWindow: true });
  const pages = windowTabs
    .filter((tab) => tab.id !== undefined && originOf(tab.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return pages[0]?.id ?? null;
}

/** `https://example.com:8443` for http(s) pages, `null` for anything else (chrome://, file://). */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function readTrusted(): Promise<TrustedSites> {
  const stored = await chrome.storage.local.get(TRUSTED_KEY);
  return (stored[TRUSTED_KEY] as TrustedSites | undefined) ?? {};
}

async function writeTrusted(sites: TrustedSites): Promise<void> {
  await chrome.storage.local.set({ [TRUSTED_KEY]: sites });
}
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
 * The chosen frame is deliberately *not* persisted: which frame owns the wasm can change between
 * documents, and a restored answer from the previous document is worse than re-probing.
 */
const SESSION_KEY = 'wasmcheat.session';
interface SessionState {
  attached: number[];
  frames: Record<string, Record<string, string>>;
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

/**
 * The bridge token lives in `chrome.storage.local` so the human pastes it once (panel or popup) and
 * it survives a service-worker restart. The MCP server mints it into `~/.wasmcheat/token`.
 */
const TOKEN_KEY = 'bridgeToken';
const TOKEN_SOURCE_KEY = 'bridgeTokenSource';
let bridgeRejected = false;
/** Set while a `bridge.pair` request is in flight, keyed by message id. */
const pairWaiters = new Map<string, (message: unknown) => void>();

async function bridgeToken(): Promise<string> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const value = stored[TOKEN_KEY];
  return typeof value === 'string' ? value.trim() : '';
}

async function tokenSource(): Promise<'paired' | 'pasted' | 'none'> {
  const stored = await chrome.storage.local.get([TOKEN_KEY, TOKEN_SOURCE_KEY]);
  if (typeof stored[TOKEN_KEY] !== 'string' || (stored[TOKEN_KEY] as string).trim() === '') return 'none';
  return stored[TOKEN_SOURCE_KEY] === 'paired' ? 'paired' : 'pasted';
}

/**
 * Fetches the token from the bridge instead of asking the human to copy a file into a password box.
 *
 * The token exists to keep *another machine* (or another user) from answering this server's calls;
 * a process running as the same user can read `~/.wasmcheat/token` anyway, so pairing over the
 * loopback socket grants nothing that user did not already have. `WASMCHEAT_PAIRING=off` turns it
 * into a manual secret again, and the panel's token field still works either way.
 */
async function pairWithBridge(timeoutMs = 4_000): Promise<string> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return '';
  const id = `pair${Date.now()}`;
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      pairWaiters.delete(id);
      resolve('');
    }, timeoutMs);
    pairWaiters.set(id, (message) => {
      clearTimeout(timer);
      pairWaiters.delete(id);
      const reply = message as { result?: { token?: unknown }; error?: { message?: string } };
      const token = reply.result?.token;
      if (typeof token === 'string' && token.length > 0) {
        // Await the write: the hello that follows asks where the token came from, and a set that is
        // still in flight would make a paired token look pasted.
        void chrome.storage.local.set({ [TOKEN_KEY]: token, [TOKEN_SOURCE_KEY]: 'paired' }).then(() => resolve(token));
        return;
      }
      processHint = reply.error?.message ?? 'pairing failed';
      resolve('');
    });
    send({ v: PROTOCOL_VERSION, kind: 'req', id, method: BRIDGE_PAIR, params: {} });
  });
}

/** Last explanation of why pairing did not work, shown in the panel next to the token field. */
let processHint = '';

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(await bridgeUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  // Every listener closes over its own socket. A late 'close' from a socket we already replaced must
  // not null out, or schedule work for, the one that is now connecting: that race silently orphans
  // the fresh socket and the bridge never comes back.
  ws.addEventListener('open', async () => {
    if (socket !== ws) return;
    reconnectDelay = RECONNECT_BASE_MS;
    let token = await bridgeToken();
    if (token === '') token = await pairWithBridge();
    if (socket !== ws) return;
    send({
      v: PROTOCOL_VERSION,
      kind: 'evt',
      event: 'bridge.hello',
      data: {
        extension: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
        token,
        paired: token !== '' && (await tokenSource()) === 'paired',
      },
    });
  });

  ws.addEventListener('message', (event) => {
    void onBridgeMessage(event.data);
  });

  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    if (event.code === 1008) {
      // The server refused the token. Retrying fast would only spam the log, so back right off and
      // tell the panel what to do; a changed token reconnects immediately.
      bridgeRejected = true;
      reconnectDelay = RECONNECT_MAX_MS;
      const hint =
        processHint !== ''
          ? `the bridge refused this extension: ${processHint}`
          : 'the bridge refused this extension: pairing failed, so paste the token from ~/.wasmcheat/token into the WasmCheat panel';
      emit('bridge.unauthorized', { hint });
      void chrome.action.setBadgeBackgroundColor({ color: '#c92a2a' });
      void chrome.action.setBadgeText({ text: '!' });
      scheduleReconnect();
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    ws.close();
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
  broadcastToPanels(event, data);
}

// ---------------------------------------------------------------- panel ports

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[TOKEN_KEY]) return;
  // A fresh token is the human's fix for a refusal, so reconnect at once instead of waiting out the
  // backed-off timer.
  bridgeRejected = false;
  reconnectDelay = RECONNECT_BASE_MS;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  void chrome.action.setBadgeText({ text: '' });
  socket?.close();
  socket = null;
  void connect();
});

const PANEL_PORT_NAME = 'wasmcheat.panel';
const AUDIT_RING_MAX = 200;

/** Ports opened by DevTools panel pages, registered on connect and dropped on disconnect. */
const panelPorts = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    // Reading lastError keeps Chrome from logging an unchecked error for a port the panel closed.
    void chrome.runtime.lastError;
  });
});

/**
 * Fan an event out to every open panel. The panel only watches, so a dead port must not stop
 * the others: the loop drops the port it could not post to and keeps going.
 */
function broadcastToPanels(event: string, data: unknown): void {
  for (const port of [...panelPorts]) {
    try {
      port.postMessage({ event, data });
    } catch {
      panelPorts.delete(port);
    }
  }
}

/**
 * The last audit lines the MCP server reported, newest first.
 *
 * Session-scoped on purpose: a browser cannot read `$WASMCHEAT_HOME/audit.jsonl`, so the server
 * mirrors each line it appends and this is only what arrived while the worker was up. The file
 * on the host stays authoritative, which is what `ext.audit`'s note says.
 */
const auditLines: unknown[] = [];

function rememberAudit(line: unknown): void {
  auditLines.unshift(line);
  if (auditLines.length > AUDIT_RING_MAX) auditLines.length = AUDIT_RING_MAX;
  broadcastToPanels(Events.auditAppended, line);
}

function auditTail(params: { limit?: number } | undefined): { lines: unknown[]; total: number; note: string } {
  const requested = Number(params?.limit ?? 50);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 50, AUDIT_RING_MAX));
  return {
    lines: auditLines.slice(0, limit),
    total: auditLines.length,
    note:
      `Session-scoped: the ${auditLines.length} line(s) the MCP server reported since this extension connected, newest ` +
      'first. The file on the host is authoritative — `node scripts/wasmcheat-cli.mjs audit <limit>` prints the full history.',
  };
}

async function onBridgeMessage(raw: unknown): Promise<void> {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  if (isEvent(parsed)) {
    onBridgeEvent(parsed.event, parsed.data);
    return;
  }
  if (isResponse(parsed)) {
    pairWaiters.get(parsed.id)?.(parsed);
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

/** Events the server pushes to us unprompted. Only the audit mirror so far. */
function onBridgeEvent(event: string, data: unknown): void {
  if (event === Events.auditAppended) rememberAudit(data);
}

async function handleBridgeRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'ext.ping':
      // `bridgeConnected` lets the DevTools status bar say whether the host is actually listening;
      // it is additive, so older callers that only read `ok`/`extension` are unaffected.
      return {
        ok: true,
        extension: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
        bridgeConnected: socket?.readyState === WebSocket.OPEN,
        bridgeRejected,
        tokenConfigured: (await bridgeToken()).length > 0,
        tokenSource: await tokenSource(),
        pairingHint: processHint,
      };
    case 'ext.listTabs':
      return listTabs();
    case 'ext.requestApproval':
      return requestApproval(params as { tabId: number; reason?: string; waitMs?: number });
    case 'ext.approvalStatus':
      return approvalStatus(params as { tabId: number });
    case 'ext.revoke':
      return revoke(params as { tabId: number; reason?: string });
    case 'ext.trust':
      return trustSite(params as { tabId: number });
    case 'ext.untrust':
      return untrustSite(params as { origin: string });
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
    case 'ext.audit':
      return auditTail(params as { limit?: number } | undefined);
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

  // A trusted site attaches without a prompt. This is the only path that grants on its own, it is
  // still per tab, and it is still reported to the audit log so the log keeps reading as a history
  // of "who let this in".
  const origin = originOf(tab.url);
  const trusted = origin ? (await readTrusted())[origin] : undefined;
  if (trusted && origin) {
    const requestId = crypto.randomUUID();
    await setApproval(params.tabId, {
      state: 'granted',
      reason: `trusted site ${origin}`,
      requestId,
      at: Date.now(),
      tabTitle: tab.title ?? '',
      tabUrl: tab.url ?? '',
    });
    emit(Events.approvalResolved, { tabId: params.tabId, state: 'granted' });
    send({
      v: PROTOCOL_VERSION,
      kind: 'evt',
      event: Events.actionAudit,
      data: {
        kind: 'approval',
        tabId: params.tabId,
        ok: true,
        summary: `attached to ${origin} without a prompt (trusted site)`,
      } satisfies ActionLine,
    });
    return {
      requestId,
      state: 'granted',
      tab: { title: tab.title ?? '', url: tab.url ?? '' },
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

/**
 * Adds the tab's origin to the trusted list and grants this tab, so a site you play daily stops
 * asking. Deliberately not reachable over the bridge: an agent that could trust its own targets
 * would be approving itself, which is the one decision the human keeps.
 */
async function trustSite(params: { tabId: number }): Promise<{ ok: true; origin: string }> {
  const tab = await getTab(params.tabId);
  const origin = originOf(tab.url);
  if (!origin) throw new BridgeError('UNSUPPORTED', 'only http(s) pages can be trusted');
  const trusted = await readTrusted();
  trusted[origin] = { origin, at: Date.now(), label: tab.title ?? origin };
  await writeTrusted(trusted);
  await setApproval(params.tabId, {
    state: 'granted',
    reason: `trusted site ${origin}`,
    requestId: crypto.randomUUID(),
    at: Date.now(),
    tabTitle: tab.title ?? '',
    tabUrl: tab.url ?? '',
  });
  emit(Events.approvalResolved, { tabId: params.tabId, state: 'granted' });
  send({
    v: PROTOCOL_VERSION,
    kind: 'evt',
    event: Events.actionAudit,
    data: { kind: 'trust', tabId: params.tabId, ok: true, summary: `trusted ${origin}: future tabs there attach without a prompt` } satisfies ActionLine,
  });
  return { ok: true, origin };
}

/** Forgetting a site also revokes the tabs that were riding on it, so the state cannot lie. */
async function untrustSite(params: { origin: string }): Promise<{ ok: true; revoked: number[] }> {
  const trusted = await readTrusted();
  delete trusted[params.origin];
  await writeTrusted(trusted);
  const revokeQueue: number[] = [];
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || originOf(tab.url) !== params.origin) continue;
    const approvals = await readApprovals();
    if (approvals[String(tab.id)]?.reason === `trusted site ${params.origin}`) revokeQueue.push(tab.id);
  }
  for (const tabId of revokeQueue) {
    await setApproval(tabId, {
      state: 'revoked',
      reason: `forgot the trusted site ${params.origin}`,
      requestId: '',
      at: Date.now(),
    });
    emit(Events.approvalResolved, { tabId, state: 'revoked' });
  }
  send({
    v: PROTOCOL_VERSION,
    kind: 'evt',
    event: Events.actionAudit,
    data: { kind: 'trust', tabId: revokeQueue[0] ?? 0, ok: true, summary: `forgot trusted site ${params.origin} (${revokeQueue.length} tab(s) revoked)` } satisfies ActionLine,
  });
  return { ok: true, revoked: revokeQueue };
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
  await reportAction(params.tabId, 'ext.reload', params, { reloaded: true }, undefined);
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
  // Through `callTab`, so arming is gated on approval and lands in the same audit funnel as an
  // agent's `page.trace.arm` — a human clicking "Arm & reload" must not be invisible.
  return callTab({ tabId: params.tabId, method: 'page.trace.arm', params: options, timeoutMs: 8_000 });
}

async function ensureAgent(params: { tabId: number; reload?: boolean; frameId?: number }): Promise<PageAgentInfo> {
  await getTab(params.tabId);
  let reloaded = false;

  const attachOnce = async (reload: boolean): Promise<PageAgentInfo> => {
    if (reload) {
      await chrome.tabs.reload(params.tabId);
      reloaded = true;
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
    const info = await helloWithRetry(params.tabId, frameId);
    return frameId === undefined ? info : { ...info, frameId };
  };

  try {
    const info = await attachOnce(params.reload === true);
    return reloaded ? { ...info, autoReloaded: true } : info;
  } catch (error) {
    // The one failure worth fixing without asking: a page that was open before the extension was
    // installed has no relay and never will, and "reload the tab yourself, then call me again" is
    // the step where people stop. Reload once, automatically, and report that it happened.
    const missingRelay =
      error instanceof BridgeError &&
      error.code === 'NO_AGENT' &&
      /needs a reload|no WasmCheat relay/i.test(error.message);
    if (!missingRelay || reloaded || params.reload === false) throw error;
    const info = await attachOnce(true);
    return { ...info, autoReloaded: true };
  }
}

/**
 * Right after a reload the document can be replaced between the relay announcing itself and this
 * call, and a message sent to a dying frame resolves with no payload at all. That is a race, not a
 * missing agent, so it is worth a few hundred milliseconds before telling the human to reload.
 */
async function helloWithRetry(tabId: number, frameId: number | undefined): Promise<PageAgentInfo> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await sendToTab<PageAgentInfo>(tabId, 'page.hello', {}, 8_000, frameId);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof BridgeError && error.code === 'NO_AGENT';
      if (!retryable || attempt === 6) break;
      await sleep(250);
    }
  }
  throw lastError instanceof Error ? lastError : new BridgeError('NO_AGENT', `tab ${tabId} has no agent`);
}

/**
 * Which frame holds the wasm? Games usually live in a cross-origin subframe, and a content
 * script in the top frame cannot see into it. Ask every frame we know about and pick the one
 * that actually captured an instance; fall back to the frame with the most instances.
 */
async function resolveFrame(tabId: number): Promise<number | undefined> {
  const cached = activeFrame.get(tabId);
  if (cached !== undefined) {
    // Frame ids are per document and a page made of iframes throws them away constantly (YouTube
    // Playables re-creates its game frame on every ad break). Trusting the cache blindly is how a
    // live tab reports NO_AGENT, so ask the frame whether it is still there.
    try {
      await sendToTab<PageAgentInfo>(tabId, 'page.hello', {}, FRAME_PROBE_TIMEOUT_MS, cached);
      return cached;
    } catch {
      activeFrame.delete(tabId);
    }
  }

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

/** Audit kinds the host understands; the extension only ever picks from this list. */
type ActionKind =
  | 'write'
  | 'freeze'
  | 'watch'
  | 'scan'
  | 'hook'
  | 'patch'
  | 'reload'
  | 'bookmark'
  | 'speed'
  | 'trace'
  | 'approval'
  | 'trust';

interface ActionLine {
  kind: ActionKind;
  tabId: number;
  ok: boolean;
  summary: string;
  detail?: unknown;
}

/**
 * The page methods that mutate something. Every one of them is reported to the host for the audit
 * log, whether it was an agent or a human in the panel that triggered it: `callTab` is the single
 * funnel, so the log cannot miss a path.
 */
async function reportAction(tabId: number, method: string, params: unknown, result: unknown, error: unknown): Promise<void> {
  const line = describeAction(tabId, method, params, result, error);
  if (!line) return;
  send({ v: PROTOCOL_VERSION, kind: 'evt', event: Events.actionAudit, data: line });
}

function describeAction(
  tabId: number,
  method: string,
  params: unknown,
  result: unknown,
  error: unknown,
): ActionLine | null {
  const p = params as Record<string, unknown> | null;
  const r = (result ?? null) as Record<string, unknown> | null;
  const ok = !error;
  const failure = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  // The page receives a parsed `{instanceId, offset}` when the caller is an MCP tool and a string
  // like `w1:0x408` when it is the panel or the raw console. The log should read the same either way.
  const addressOf = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'instanceId' in value && 'offset' in value) {
      const target = value as { instanceId: string; offset: number };
      return formatAddress(target);
    }
    return undefined;
  };
  const address = addressOf(p?.address);
  const valueOf = (key: string): unknown => (r && key in r ? r[key] : p?.[key]);

  switch (method) {
    case 'page.write':
      return {
        kind: 'write',
        tabId,
        ok,
        summary: ok
          ? `write ${address ?? '?'} ${String(p?.type ?? '')} ${String(r?.before)} -> ${String(r?.after)}`
          : `write ${address ?? '?'} failed: ${failure}`,
        detail: { requested: p?.value },
      };
    case 'page.speed.set':
      return {
        kind: 'speed',
        tabId,
        ok,
        summary: ok ? `speed ${String(r?.scale ?? p?.scale)}x` : `speed change failed: ${failure}`,
        detail: { scale: p?.scale },
      };
    case 'page.bookmark.add':
      return {
        kind: 'bookmark',
        tabId,
        ok,
        summary: ok
          ? `bookmark "${String(r?.label ?? p?.label)}" -> ${String(r?.address ?? p?.address)}`
          : `bookmark "${String(p?.label)}" failed: ${failure}`,
        detail: { type: p?.type },
      };
    case 'page.bookmark.remove':
      return {
        kind: 'bookmark',
        tabId,
        ok,
        summary: ok ? `bookmark ${String(p?.id)} removed` : `bookmark removal failed: ${failure}`,
      };
    case 'page.bookmark.clear':
      return { kind: 'bookmark', tabId, ok, summary: ok ? `bookmarks cleared (${String(r?.removed ?? 0)})` : `bookmark clear failed: ${failure}` };
    case 'page.freeze.set':
      return {
        kind: 'freeze',
        tabId,
        ok,
        summary: ok
          ? `freeze ${address ?? '?'} ${String(p?.type ?? '')} = ${String(p?.value)}`
          : `freeze ${address ?? '?'} failed: ${failure}`,
        detail: { freezeId: r?.id },
      };
    case 'page.freeze.clear':
      return { kind: 'freeze', tabId, ok, summary: ok ? `freeze cleared ${String(p?.freezeId)}` : `freeze clear failed: ${failure}` };
    case 'page.watch.add':
      return {
        kind: 'watch',
        tabId,
        ok,
        summary: ok ? `watch added ${address ?? '?'} ${String(p?.type ?? '')}` : `watch add failed: ${failure}`,
        detail: { watchId: r?.id },
      };
    case 'page.watch.remove':
      return { kind: 'watch', tabId, ok, summary: ok ? `watch removed ${String(p?.watchId)}` : `watch remove failed: ${failure}` };
    case 'page.scan.begin':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `scan ${String(r?.scanId)} ${String(r?.mode ?? p?.mode)} ${String(p?.type)}${p?.value === undefined ? '' : ` = ${String(p.value)}`} -> ${String(r?.matchCount)} match(es)`
          : `scan failed: ${failure}`,
        detail: { instanceId: p?.instanceId, truncated: r?.truncated },
      };
    case 'page.scan.next':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `scan ${String(p?.scanId)} narrowed by ${String(p?.mode)} -> ${String(r?.matchCount)} match(es)`
          : `scan narrowing failed: ${failure}`,
        detail: { mode: p?.mode, value: p?.value },
      };
    case 'page.scan.drop':
      return { kind: 'scan', tabId, ok, summary: ok ? `scan ${String(p?.scanId)} dropped` : `scan drop failed: ${failure}` };
    case 'page.scan.text':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `text scan ${String(p?.encoding ?? 'ascii')} "${String(p?.text)}" -> ${String(r?.total)} match(es)`
          : `text scan failed: ${failure}`,
      };
    case 'page.pointer.scan':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `pointer scan for ${String(p?.instanceId)}:0x${Number(p?.offset ?? 0).toString(16)} (depth ${String(p?.maxDepth ?? 3)}) -> ${Array.isArray(r) ? r.length : 0} chain(s)`
          : `pointer scan failed: ${failure}`,
        detail: { maxOffset: p?.maxOffset },
      };
    case 'page.trace.arm':
      return {
        kind: 'trace',
        tabId,
        ok,
        summary: ok
          ? `trace armed on ${address ?? '?'} ${String(p?.kind ?? 'write')} ${String(p?.type ?? 'i32')}`
          : `trace arming failed: ${failure}`,
        detail: { installed: (r as { installed?: boolean } | null)?.installed, maxHits: p?.maxHits },
      };
    case 'page.trace.stop':
      return { kind: 'trace', tabId, ok, summary: ok ? 'trace stopped' : `trace stop failed: ${failure}` };
    case 'page.trace.clear':
      return { kind: 'trace', tabId, ok, summary: ok ? 'trace hits cleared' : `trace clear failed: ${failure}` };
    case 'page.hook.add':
      return {
        kind: 'hook',
        tabId,
        ok,
        summary: ok
          ? `hook added on ${String(p?.target)} ${String(p?.name)}${r?.pending === true ? ' (applies at the next instantiation)' : ''}`
          : `hook add failed: ${failure}`,
        detail: { hookId: r?.id, body: p?.body },
      };
    case 'page.hook.setEnabled':
      return {
        kind: 'hook',
        tabId,
        ok,
        summary: ok ? `hook ${String(p?.hookId)} ${p?.enabled === true ? 'enabled' : 'disabled'}` : `hook toggle failed: ${failure}`,
      };
    case 'page.hook.remove':
      return { kind: 'hook', tabId, ok, summary: ok ? `hook removed ${String(p?.hookId)}` : `hook remove failed: ${failure}` };
    case 'page.patch.add':
      return {
        kind: 'patch',
        tabId,
        ok,
        summary: ok ? `patch added on ${String(p?.target)} (${String(p?.mode ?? 'stub')})` : `patch add failed: ${failure}`,
        detail: { mode: p?.mode, value: p?.value },
      };
    case 'page.patch.remove':
      return { kind: 'patch', tabId, ok, summary: ok ? `patch removed ${String(p?.patchId)}` : `patch remove failed: ${failure}` };
    case 'page.patch.clear':
      return { kind: 'patch', tabId, ok, summary: ok ? 'all patches cleared' : `patch clear failed: ${failure}` };
    case 'ext.reload':
      return {
        kind: 'reload',
        tabId,
        ok,
        summary: ok ? `reloaded tab ${tabId} so the next instantiation picks up hooks and patches` : `reload failed: ${failure}`,
      };
    default:
      return null;
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
    const result = await sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, frameId);
    await reportAction(params.tabId, params.method, params.params, result, undefined);
    return result;
  } catch (error) {
    // The right realm can change without the page reloading: a Playables game boots inside a frame
    // that did not exist when we picked one, and the request lands where the instance id is unknown.
    // Re-probe (the frame with the most instances wins) and ask again, once.
    if (error instanceof BridgeError && (error.code === 'NO_INSTANCE' || error.code === 'NO_MEMORY')) {
      activeFrame.delete(params.tabId);
      persistSession();
      const probed = await resolveFrame(params.tabId);
      if (probed !== frameId) {
        try {
          const result = await sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, probed);
          await reportAction(params.tabId, params.method, params.params, result, undefined);
          return result;
        } catch (retryError) {
          await reportAction(params.tabId, params.method, params.params, undefined, retryError);
          throw retryError;
        }
      }
    }
    if (!(error instanceof BridgeError) || error.code !== 'NO_AGENT') {
      await reportAction(params.tabId, params.method, params.params, undefined, error);
      throw error;
    }
    await injectAgent(params.tabId);
    attachedTabs.add(params.tabId);
    const retryId = frameId ?? (await resolveFrame(params.tabId));
    try {
      const result = await sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, retryId);
      await reportAction(params.tabId, params.method, params.params, result, undefined);
      return result;
    } catch (retryError) {
      await reportAction(params.tabId, params.method, params.params, undefined, retryError);
      throw retryError;
    }
  }
}

async function sendToTab<T>(
  tabId: number,
  method: string,
  params: unknown,
  timeoutMs: number,
  frameId?: number,
): Promise<T> {
  const message = { type: 'wasmcheat.rpc', method, params };
  const send = (toFrame?: number): Promise<unknown> =>
    withTimeout(
      toFrame === undefined ? chrome.tabs.sendMessage(tabId, message) : chrome.tabs.sendMessage(tabId, message, { frameId: toFrame }),
      timeoutMs,
      method,
    );
  let response: unknown;
  try {
    response = await send(frameId);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const lostFrame = /Receiving end does not exist|Could not establish connection|No frame with id/i.test(text);
    if (lostFrame && frameId !== undefined) {
      // The frame we routed to is gone; every frame gets the call and the first relay that answers
      // wins. The next call re-probes instead of reusing the dead id.
      activeFrame.delete(tabId);
      try {
        response = await send(undefined);
      } catch (retryError) {
        const retryText = retryError instanceof Error ? retryError.message : String(retryError);
        if (/Receiving end does not exist|Could not establish connection|No frame with id/i.test(retryText)) {
          throw new BridgeError('NO_AGENT', `no WasmCheat relay in tab ${tabId}; the page needs a reload`);
        }
        throw retryError;
      }
    } else if (lostFrame) {
      throw new BridgeError('NO_AGENT', `no WasmCheat relay in tab ${tabId}; the page needs a reload`);
    } else {
      throw error;
    }
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
  const msg = message as
    | { type?: string; tabId?: number; channelId?: string; url?: string; event?: string; data?: unknown; origin?: string }
    | null;
  if (!msg?.type) return undefined;

  if (msg.type === 'wasmcheat.event') {
    // A page agent occurrence (a watchpoint hit), addressed to whoever is waiting for it on the
    // bridge. The tab comes from the sender, so a page cannot claim to speak for another tab.
    const tabId = sender.tab?.id;
    if (tabId !== undefined && typeof msg.event === 'string') {
      emit(Events.pageEvent, { tabId, frameId: sender.frameId ?? 0, event: msg.event, data: msg.data });
    }
    return undefined;
  }

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

  if (msg.type === 'wasmcheat.panel.call') {
    // The DevTools panel goes through the very dispatcher the WebSocket uses, so the approval
    // gate, frame routing, worker routing and error shapes are identical: a panel is a second
    // front-end, not a trust bypass.
    const call = msg as unknown as { method?: unknown; params?: unknown };
    void (async () => {
      if (typeof call.method !== 'string') {
        sendResponse(errorReply(new BridgeError('BAD_PARAMS', 'wasmcheat.panel.call needs a method string')));
        return;
      }
      try {
        sendResponse({ result: await handleBridgeRequest(call.method, call.params) });
      } catch (error) {
        sendResponse(errorReply(error));
      }
    })();
    return true;
  }

  if (msg.type === 'popup.state') {
    void (async () => {
      sendResponse({
        approvals: await readApprovals(),
        tabs: await listTabs(),
        activeTabId: await pickActiveTab(),
        trusted: Object.values(await readTrusted()).sort((a, b) => a.origin.localeCompare(b.origin)),
        bridgeConnected: socket?.readyState === WebSocket.OPEN,
        bridgeRejected,
        tokenConfigured: (await bridgeToken()).length > 0,
        tokenSource: await tokenSource(),
        pairingHint: processHint,
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

  if (msg.type === 'popup.trust' && typeof msg.tabId === 'number') {
    const trustedTabId = msg.tabId;
    void (async () => {
      try {
        sendResponse(await trustSite({ tabId: trustedTabId }));
      } catch (error) {
        sendResponse(errorReply(error));
      }
    })();
    return true;
  }

  if (msg.type === 'popup.untrust' && typeof msg.origin === 'string') {
    const origin = msg.origin;
    void (async () => {
      try {
        sendResponse(await untrustSite({ origin }));
      } catch (error) {
        sendResponse(errorReply(error));
      }
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

/** Same normalisation the bridge response uses, so a panel sees the identical code and message. */
function errorReply(error: unknown): { error: BridgeErrorShape } {
  return { error: makeErrorResponse('panel', error).error ?? { code: 'INTERNAL', message: String(error) } };
}

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
