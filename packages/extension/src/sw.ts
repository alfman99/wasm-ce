import {
  BRIDGE_CHALLENGE,
  BRIDGE_HELLO,
  BRIDGE_PAIR,
  BRIDGE_WELCOME,
  BridgeError,
  Events,
  PROTOCOL_VERSION,
  isEvent,
  isRequest,
  isResponse,
  makeErrorResponse,
  makeResponse,
  type BridgeErrorShape,
  type PageAgentInfo,
  type PageDiagnostics,
  type TabInfo,
  formatAddress,
  type ValueType,
  bridgeNonce,
  bridgeProof,
} from '@wasmcheat/protocol';

/**
 * Service worker: the only part of the extension that talks to the MCP server.
 *
 * There is no approval step: opening the panel on a tab is the human saying yes, so every
 * page-level call funnels through `callTab`, which only has to find the right frame, do the
 * work and report it.
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
/**
 * MV3 terminates an idle service worker after 30s. A tab that is still loading (or a wait for a
 * page reload during attach) looks exactly like idleness to Chrome, and the bridge would then find
 * no socket. An alarm every 30s (Chrome's minimum period from 120; 116 to 119 round it up to a
 * minute) wakes the worker and redials the bridge.
 */
const KEEPALIVE_MS = 30_000;

let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const attachedTabs = new Set<number>();
/** tabId → frameId → url, filled from relay announcements (one per frame). */
const tabFrames = new Map<number, Map<number, string>>();
/** tabId → the frame that owns the wasm, so page.* calls land in the right realm. */
const activeFrame = new Map<number, number>();
/** Tabs whose picked frame held no wasm when it was picked, and since when: see resolveFrame. */
const emptyFramePick = new Map<number, number>();
const EMPTY_FRAME_RECHECK_MS = 2_000;
/**
 * tabId → the top frame's documentId. A relay only announces when its document starts, so an
 * announcement from frame 0 with a new id is a new top document (a reload or a navigation), and the
 * frames of the old one are gone. `tabs.onUpdated` cannot say that: an iframe loading flips the
 * tab's status to 'loading' too, and a Playables page re-creates its game frame on every ad break.
 */
const topDocument = new Map<number, string>();

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

/**
 * tabId → a watchpoint that must be re-armed in the next document.
 *
 * A watchpoint only exists if it is in place before the app compiles its module, so the intent
 * has to outlive the reload that creates that document. The relay announces itself at
 * document_start, which is where we put it back.
 */
interface TraceOptions {
  address: string;
  type?: string;
  maxHits?: number;
  kind?: string;
}
/**
 * The intent is consumed by the one reload it asked for: `armedIn` is the top document it was armed
 * in (already armed directly), `document` the next top document, which gets it in every frame. A
 * later document, or a document on another site, drops it instead of being watched unasked.
 */
interface PendingTrace {
  options: TraceOptions;
  origin: string | null;
  armedIn?: string;
  document?: string;
}
const pendingTraces = new Map<number, PendingTrace>();

/**
 * Everything above is in memory, which an MV3 worker loses whenever Chrome suspends it — and a
 * suspension costs the human a re-attach and the agent a scan session. So the routing state
 * (which frames exist, which one owns the wasm, what watchpoint is pending) is mirrored into
 * `chrome.storage.session`: same trust level as the grant table, gone when the browser closes.
 * The chosen frame is deliberately *not* persisted: which frame owns the wasm can change between
 * documents, and a restored answer from the previous document is worse than re-probing.
 */
/**
 * Restoring routing state is a storage read. A request, a relay announcement or a tab event that
 * arrives first must wait for it, or the restore overwrites what it recorded with older state.
 */
let sessionReady: Promise<void> = Promise.resolve();

const SESSION_KEY = 'wasmcheat.session';
interface SessionState {
  attached: number[];
  frames: Record<string, Record<string, string>>;
  documents: Record<string, string>;
  traces: Record<string, PendingTrace>;
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
      documents: Object.fromEntries(topDocument),
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
    for (const [tabId, id] of Object.entries(stored.documents ?? {})) topDocument.set(Number(tabId), id);
    for (const [tabId, trace] of Object.entries(stored.traces ?? {})) pendingTraces.set(Number(tabId), trace);
  } catch {
    // A fresh window has no session state; nothing to restore.
  }
}
sessionReady = restoreSession();

// ---------------------------------------------------------------- bridge socket

/**
 * The bridge token lives in `chrome.storage.local` so the human pastes it once (panel or popup) and
 * it survives a service-worker restart. The MCP server mints it into `~/.wasmcheat/token`.
 */
const TOKEN_KEY = 'bridgeToken';
const TOKEN_SOURCE_KEY = 'bridgeTokenSource';
let bridgeRejected = false;
/**
 * Per socket: whether the server sent its challenge, the welcome proof it must answer the hello
 * with, and whether it did. Until `bridgeTrusted`, `send` drops everything and requests are ignored.
 */
let challenged = false;
let expectedWelcome = '';
let bridgeTrusted = false;
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
    sendUntrusted({ v: PROTOCOL_VERSION, kind: 'req', id, method: BRIDGE_PAIR, params: {} });
  });
}

/** Last explanation of why pairing did not work, shown in the panel next to the token field. */
let processHint = '';

let probing = false;

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (probing) return;
  probing = true;
  let url: string;
  try {
    url = await bridgeUrl();
    // Chrome logs every refused WebSocket as an error on the extension's Errors page and in its
    // console, and no script can catch it. A refused fetch is silent, so ask first whether anything
    // listens (the bridge answers a plain GET with 426) and dial only when something does.
    await fetch(url.replace(/^ws/, 'http'), { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(2_000) });
  } catch {
    probing = false;
    scheduleReconnect();
    return;
  }
  probing = false;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  challenged = false;
  expectedWelcome = '';
  bridgeTrusted = false;

  // Every listener closes over its own socket. A late 'close' from a socket we already replaced must
  // not null out, or schedule work for, the one that is now connecting: that race silently orphans
  // the fresh socket and the bridge never comes back.
  ws.addEventListener('open', () => {
    if (socket === ws) reconnectDelay = RECONNECT_BASE_MS;
  });

  ws.addEventListener('message', (event) => {
    if (socket === ws) void onBridgeMessage(ws, event.data);
  });

  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    bridgeTrusted = false;
    if (event.code === 1008) {
      // The server refused the hello. Retrying fast would only spam the log; a changed token
      // reconnects immediately.
      refuseBridge(
        processHint !== ''
          ? `the bridge refused this extension: ${processHint}`
          : 'the bridge refused this extension: pairing failed, so paste the token from ~/.wasmcheat/token into the WasmCheat panel',
      );
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

/**
 * Answers the server's challenge: pairs first if there is no token, then proves the token without
 * sending it and remembers the proof the server has to send back.
 */
async function sayHello(ws: WebSocket, data: unknown): Promise<void> {
  const serverNonce = (data as { nonce?: unknown } | null)?.nonce;
  if (challenged || typeof serverNonce !== 'string') return;
  challenged = true;
  processHint = '';
  let token = await bridgeToken();
  if (token === '') token = await pairWithBridge();
  const nonce = bridgeNonce();
  // No token means pairing failed: the empty hello makes the server close with 1008, and that
  // path tells the panel what to paste.
  const proof = token === '' ? '' : await bridgeProof(token, 'ext', serverNonce, nonce);
  const welcome = token === '' ? '' : await bridgeProof(token, 'srv', serverNonce, nonce);
  const paired = token !== '' && (await tokenSource()) === 'paired';
  if (socket !== ws) return;
  expectedWelcome = welcome;
  sendUntrusted({
    v: PROTOCOL_VERSION,
    kind: 'evt',
    event: BRIDGE_HELLO,
    data: { extension: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION, nonce, proof, paired },
  });
}

/**
 * The server's half of the proof. Checked synchronously, before the requests queued behind it are
 * read. A wrong one means something else holds the port, so drop it and back off.
 */
function onWelcome(ws: WebSocket, data: unknown): void {
  const proof = (data as { proof?: unknown } | null)?.proof;
  if (expectedWelcome !== '' && typeof proof === 'string' && sameText(proof, expectedWelcome)) {
    bridgeTrusted = true;
    bridgeRejected = false;
    processHint = '';
    void chrome.action.setBadgeText({ text: '' });
    return;
  }
  processHint =
    'the program on the bridge port could not prove it holds the token; stop whatever else listens there and start the WasmCheat MCP server';
  refuseBridge(processHint);
  ws.close();
}

function refuseBridge(hint: string): void {
  bridgeRejected = true;
  reconnectDelay = RECONNECT_MAX_MS;
  broadcastToPanels('bridge.unauthorized', { hint });
  void chrome.action.setBadgeBackgroundColor({ color: '#c92a2a' });
  void chrome.action.setBadgeText({ text: '!' });
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** Everything the extension says goes to a server that proved it holds the token, or nowhere. */
function send(payload: unknown): void {
  if (bridgeTrusted) sendUntrusted(payload);
}

/** Only for the handshake: the pairing request and the hello. */
function sendUntrusted(payload: unknown): void {
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
  // Audit lines and page events are for the panel, not for a content script that asks by name.
  if (port.name !== PANEL_PORT_NAME || !port.sender || !fromExtensionPage(port.sender)) return;
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
      `Session-scoped: the ${count(auditLines.length, 'line')} the MCP server reported since this extension connected, newest ` +
      'first. The file on the host is authoritative: `node scripts/wasmcheat-cli.mjs audit <limit>` prints the full history.',
  };
}

async function onBridgeMessage(ws: WebSocket, raw: unknown): Promise<void> {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return;
  }
  if (isEvent(parsed)) {
    if (parsed.event === BRIDGE_CHALLENGE) void sayHello(ws, parsed.data);
    else if (parsed.event === BRIDGE_WELCOME) onWelcome(ws, parsed.data);
    else if (bridgeTrusted) onBridgeEvent(parsed.event, parsed.data);
    return;
  }
  if (isResponse(parsed)) {
    // The pairing answer is the one thing believed before the server's proof: it is what gives the
    // extension a token to check that proof with (trust on first use).
    pairWaiters.get(parsed.id)?.(parsed);
    return;
  }
  if (!isRequest(parsed) || !bridgeTrusted) return;

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

/** Who asked: the MCP server records some calls itself, so the extension must not report them again. */
type CallOrigin = 'bridge' | 'panel';

async function handleBridgeRequest(method: string, params: unknown, origin: CallOrigin = 'bridge'): Promise<unknown> {
  await sessionReady;
  switch (method) {
    case 'ext.ping':
      // `bridgeConnected` lets the DevTools status bar say whether the host is actually listening;
      // it is additive, so older callers that only read `ok`/`extension` are unaffected.
      return {
        ok: true,
        extension: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
        bridgeConnected: bridgeTrusted && socket?.readyState === WebSocket.OPEN,
        bridgeRejected,
        tokenConfigured: (await bridgeToken()).length > 0,
        tokenSource: await tokenSource(),
        pairingHint: processHint,
      };
    case 'ext.listTabs':
      return listTabs();
    case 'ext.ensureAgent':
      return ensureAgent(params as { tabId: number; reload?: boolean; frameId?: number });
    case 'ext.call':
      return callTab(params as { tabId: number; method: string; params?: unknown; timeoutMs?: number }, origin);
    case 'ext.detach':
      return detach(params as { tabId: number });
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

// ---------------------------------------------------------------- tabs

/** Forgets everything this worker knows about a tab; the next call re-injects the agent. */
async function detach(params: { tabId: number }): Promise<{ ok: true }> {
  attachedTabs.delete(params.tabId);
  activeFrame.delete(params.tabId);
  tabFrames.delete(params.tabId);
  topDocument.delete(params.tabId);
  pendingTraces.delete(params.tabId);
  persistSession();
  // Not reported from here: only the MCP server calls ext.detach, and it records the detach itself.
  return { ok: true };
}

// ---------------------------------------------------------------- page calls

/**
 * Reloads a tab so the next document is instrumented from `document_start`.
 *
 * A watchpoint has to be in place before the app compiles its module, so tracing a page that is
 * already running means reloading it. The grant, hooks and patches that existed before are gone
 * with the old document — the agent asked for this reload, so it knows.
 */
async function reloadTab(params: { tabId: number }): Promise<{ reloaded: true }> {
  forgetDocument(params.tabId);
  await chrome.tabs.reload(params.tabId);
  const ready = await waitFor(() => attachedTabs.has(params.tabId), 15_000);
  if (!ready) {
    throw new BridgeError('NO_AGENT', `tab ${params.tabId} did not re-attach after reload`);
  }
  await reportAction(params.tabId, 'ext.reload', params, { reloaded: true }, undefined);
  return { reloaded: true };
}

/**
 * Forgets the routing of a tab's current document; the relays of the next one announce their frames
 * again. It also makes "wait until attached" mean the new document, not the old one.
 */
function forgetDocument(tabId: number): void {
  attachedTabs.delete(tabId);
  tabFrames.delete(tabId);
  activeFrame.delete(tabId);
  emptyFramePick.delete(tabId);
  persistSession();
}

/** Arms a write watchpoint now and remembers it for the next document of that tab. */
async function traceArm(params: {
  tabId: number;
  address: string;
  type?: string;
  maxHits?: number;
  kind?: string;
}): Promise<unknown> {
  const options: TraceOptions = {
    address: params.address,
    ...(params.type ? { type: params.type } : {}),
    ...(params.maxHits ? { maxHits: params.maxHits } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  };
  const tab = await getTab(params.tabId);
  pendingTraces.set(params.tabId, { options, origin: originOf(tab.url), armedIn: topDocument.get(params.tabId) });
  persistSession();
  // Through `callTab`, so arming lands in the same audit funnel as an agent's `page.trace.arm`:
  // a human clicking "Arm & reload" must not be invisible.
  try {
    return await callTab({ tabId: params.tabId, method: 'page.trace.arm', params: options, timeoutMs: 8_000 });
  } catch (error) {
    // A refused arm (a worker instance is UNSUPPORTED) must not be re-sent after the next reload.
    pendingTraces.delete(params.tabId);
    persistSession();
    throw error;
  }
}

async function ensureAgent(params: { tabId: number; reload?: boolean; frameId?: number }): Promise<PageAgentInfo> {
  await getTab(params.tabId);
  let reloaded = false;
  let injected = false;

  const attachOnce = async (reload: boolean): Promise<PageAgentInfo> => {
    if (reload) {
      forgetDocument(params.tabId);
      await chrome.tabs.reload(params.tabId);
      reloaded = true;
      const ready = await waitFor(() => attachedTabs.has(params.tabId), 15_000);
      if (!ready) {
        throw new BridgeError('NO_AGENT', `tab ${params.tabId} did not re-attach after reload`);
      }
    } else if (!attachedTabs.has(params.tabId)) {
      await injectAgent(params.tabId);
      injected = true;
    }

    // Re-resolve every attach: a reloaded page may instantiate its wasm somewhere else.
    activeFrame.delete(params.tabId);
    if (params.frameId !== undefined) {
      activeFrame.set(params.tabId, params.frameId);
      persistSession();
    }
    return helloWithRetry(params.tabId, params.frameId);
  };

  try {
    let info = await attachOnce(params.reload === true);
    // Injected into a page that was already running: a game that instantiated before the agent
    // arrived is invisible to it until the page starts again. Reload once when the page looks like
    // one (a canvas or a .wasm reference, but no instance), never for an ordinary page.
    if (injected && params.reload !== true && (await missedGame(params.tabId))) info = await attachOnce(true);
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
async function helloWithRetry(tabId: number, pinned: number | undefined): Promise<PageAgentInfo> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      // Resolved per attempt: a frame that vanished was dropped by sendToTab, so the next try
      // re-probes instead of knocking on the dead id again.
      const frameId = pinned ?? (await resolveFrame(tabId));
      const info = await sendToTab<PageAgentInfo>(tabId, 'page.hello', {}, 8_000, frameId);
      return { ...info, frameId };
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
async function resolveFrame(tabId: number): Promise<number> {
  // Trusted without a probe: the panel reads several times a second, and a hello before every call
  // doubled each one. A frame that went away (YouTube Playables re-creates its game frame on every
  // ad break) fails fast in sendToTab, which drops it, and callTab picks a frame again. A pick that
  // held no wasm is only a guess, though: the game frame often instantiates after the panel opened,
  // so that pick is asked again every couple of seconds until a frame has an instance.
  const cached = activeFrame.get(tabId);
  const emptySince = emptyFramePick.get(tabId);
  if (cached !== undefined && (emptySince === undefined || Date.now() - emptySince < EMPTY_FRAME_RECHECK_MS)) {
    return cached;
  }

  // Nothing announced yet (a page from before the install): the top frame is the honest default.
  // Never "every frame": instance ids start at w1 in each realm, so a broadcast write lands twice.
  const frames = tabFrames.get(tabId);
  if (!frames || frames.size === 0) return 0;
  if (frames.size === 1) {
    const [only = 0] = [...frames.keys()];
    activeFrame.set(tabId, only);
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
  if (best) {
    activeFrame.set(tabId, best.frameId);
    if (best.instances === 0) emptyFramePick.set(tabId, Date.now());
    else emptyFramePick.delete(tabId);
  }
  return best?.frameId ?? 0;
}

/** Every frame of the tab, asked whether it holds wasm or merely looks like a game that does. */
async function missedGame(tabId: number): Promise<boolean> {
  let looksLikeGame = false;
  for (const [frameId, url] of tabFrames.get(tabId) ?? new Map<number, string>([[0, '']])) {
    if (url && !/^https?:/i.test(url)) continue;
    try {
      const info = await sendToTab<PageDiagnostics>(tabId, 'page.diagnose', {}, 2_000, frameId);
      if (info.instances > 0) return false;
      if (info.canvases > 0 || info.wasmReferences.length > 0) looksLikeGame = true;
    } catch {
      // A frame without a relay cannot say; the others decide.
    }
  }
  return looksLikeGame;
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
  | 'detach';

interface ActionLine {
  kind: ActionKind;
  tabId: number;
  ok: boolean;
  summary: string;
  detail?: unknown;
}

/** The MCP server records these itself, in its tool's words; only a panel's call is reported here. */
const SERVER_AUDITED = new Set(['page.saved.save', 'page.saved.open', 'page.saved.delete']);

/** `1 match`, `3 matches`: audit lines are read by people. */
function count(value: unknown, one: string, many = `${one}s`): string {
  return `${String(value)} ${Number(value) === 1 ? one : many}`;
}

/**
 * The page methods that mutate something. Every one of them is reported to the host for the audit
 * log, whether it was an agent or a human in the panel that triggered it: `callTab` is the single
 * funnel, so the log cannot miss a path.
 */
async function reportAction(
  tabId: number,
  method: string,
  params: unknown,
  result: unknown,
  error: unknown,
  origin: CallOrigin = 'bridge',
): Promise<void> {
  if (origin === 'bridge' && SERVER_AUDITED.has(method)) return;
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
          ? `scan ${String(r?.scanId)} ${String(r?.mode ?? p?.mode)} ${String(p?.type)}${p?.value === undefined ? '' : ` = ${String(p.value)}`} -> ${count(r?.matchCount, 'match', 'matches')}`
          : `scan failed: ${failure}`,
        detail: { instanceId: p?.instanceId, truncated: r?.truncated },
      };
    case 'page.scan.next':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `scan ${String(p?.scanId)} narrowed by ${String(p?.mode)} -> ${count(r?.matchCount, 'match', 'matches')}`
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
          ? `text scan ${String(p?.encoding ?? 'ascii')} "${String(p?.text)}" -> ${count(r?.total, 'match', 'matches')}`
          : `text scan failed: ${failure}`,
      };
    case 'page.pointer.scan':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `pointer scan for ${String(p?.instanceId)}:0x${Number(p?.offset ?? 0).toString(16)} (depth ${String(p?.maxDepth ?? 3)}) -> ${count(Array.isArray(r) ? r.length : 0, 'chain')}`
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
    case 'page.saved.save':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `saved scan "${String(r?.name ?? p?.name)}" (${count(r?.matchCount, 'match', 'matches')})`
          : `saving scan "${String(p?.name)}" failed: ${failure}`,
      };
    case 'page.saved.open': {
      const opened = (r?.summary ?? null) as { matchCount?: number } | null;
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok
          ? `re-opened saved scan "${String(p?.name)}" (${count(opened?.matchCount, 'match', 'matches')})`
          : `opening saved scan "${String(p?.name)}" failed: ${failure}`,
      };
    }
    case 'page.saved.delete':
      return {
        kind: 'scan',
        tabId,
        ok,
        summary: ok ? `deleted saved scan "${String(p?.name)}"` : `deleting saved scan "${String(p?.name)}" failed: ${failure}`,
      };
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

async function callTab(
  params: {
    tabId: number;
    method: string;
    params?: unknown;
    timeoutMs?: number;
  },
  origin: CallOrigin = 'bridge',
): Promise<unknown> {
  if (typeof params.method !== 'string' || !params.method.startsWith('page.')) {
    throw new BridgeError('BAD_PARAMS', `ext.call only forwards page.* methods, got "${params.method}"`);
  }
  if ((params.method === 'page.trace.stop' || params.method === 'page.trace.clear') && pendingTraces.delete(params.tabId)) {
    persistSession();
  }
  const timeoutMs = Math.max(1_000, Math.min(params.timeoutMs ?? RPC_TIMEOUT_MS, 120_000));
  const report = (result: unknown, error: unknown): Promise<void> =>
    reportAction(params.tabId, params.method, params.params, result, error, origin);
  const attempt = async (frameId: number): Promise<unknown> => {
    try {
      const result = await sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, frameId);
      await report(result, undefined);
      return result;
    } catch (error) {
      await report(undefined, error);
      throw error;
    }
  };
  const frameId = await resolveFrame(params.tabId);
  let result: unknown;
  try {
    result = await sendToTab(params.tabId, params.method, params.params ?? {}, timeoutMs, frameId);
  } catch (error) {
    // The right realm can change without the page reloading: a Playables game boots inside a frame
    // that did not exist when we picked one, and the request lands where the instance id is unknown.
    // Re-probe (the frame with the most instances wins) so the next call lands right, but only ask
    // again here when the call changes nothing: a mutation is never sent twice.
    if (error instanceof BridgeError && (error.code === 'NO_INSTANCE' || error.code === 'NO_MEMORY')) {
      activeFrame.delete(params.tabId);
      persistSession();
      const probed = await resolveFrame(params.tabId);
      const mutates = describeAction(params.tabId, params.method, params.params, undefined, undefined) !== null;
      if (probed !== frameId && !mutates) return attempt(probed);
    }
    if (!(error instanceof BridgeError) || error.code !== 'NO_AGENT') {
      await report(undefined, error);
      throw error;
    }
    // NO_AGENT means no live page agent took the call (no relay, a frame that is gone, a document
    // torn down mid-call), so sending it again cannot apply it twice. A subframe that went away is
    // not a missing agent: try the frame that holds the wasm now before injecting anything.
    if (frameId !== 0) {
      const again = await resolveFrame(params.tabId);
      if (again !== frameId && tabFrames.get(params.tabId)?.has(again)) return attempt(again);
    }
    await injectAgent(params.tabId);
    attachedTabs.add(params.tabId);
    return attempt(await resolveFrame(params.tabId));
  }
  await report(result, undefined);
  return result;
}

async function sendToTab<T>(
  tabId: number,
  method: string,
  params: unknown,
  timeoutMs: number,
  frameId = 0,
): Promise<T> {
  const message = { type: 'wasmcheat.rpc', method, params };
  let response: unknown;
  try {
    response = await withTimeout(chrome.tabs.sendMessage(tabId, message, { frameId }), timeoutMs, method);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/Receiving end does not exist|Could not establish connection|No frame with id/i.test(text)) throw error;
    // Never fall back to every frame: instance ids start at w1 in each realm, so the call would run
    // wherever the id happens to exist. Drop the dead frame instead; the caller re-resolves.
    if (activeFrame.get(tabId) === frameId) activeFrame.delete(tabId);
    if (tabFrames.get(tabId)?.delete(frameId)) persistSession();
    throw new BridgeError(
      'NO_AGENT',
      frameId === 0
        ? `no WasmCheat relay in tab ${tabId}; the page needs a reload`
        : `frame ${frameId} of tab ${tabId} is gone; call again to re-resolve the frame`,
    );
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
    if (tabId !== undefined) void sessionReady.then(() => onRelayReady(tabId, sender, msg.url));
    return undefined;
  }

  // Everything below is for extension pages (panel, popup): a content script runs in the page's
  // renderer, so it gets neither the dispatcher nor the list of every open tab.
  if ((msg.type === 'wasmcheat.panel.call' || msg.type === 'popup.state') && !fromExtensionPage(sender)) {
    sendResponse(errorReply(new BridgeError('BAD_PARAMS', `${msg.type} is only accepted from an extension page`)));
    return undefined;
  }

  if (msg.type === 'wasmcheat.panel.call') {
    // The DevTools panel goes through the very dispatcher the WebSocket uses, so frame routing,
    // worker routing, auditing and error shapes are identical: a panel is a second front-end,
    // not a second implementation.
    const call = msg as unknown as { method?: unknown; params?: unknown };
    void (async () => {
      if (typeof call.method !== 'string') {
        sendResponse(errorReply(new BridgeError('BAD_PARAMS', 'wasmcheat.panel.call needs a method string')));
        return;
      }
      try {
        sendResponse({ result: await handleBridgeRequest(call.method, call.params, 'panel') });
      } catch (error) {
        sendResponse(errorReply(error));
      }
    })();
    return true;
  }

  if (msg.type === 'popup.state') {
    void (async () => {
      sendResponse({
        tabs: await listTabs(),
        activeTabId: await pickActiveTab(),
        bridgeConnected: bridgeTrusted && socket?.readyState === WebSocket.OPEN,
        bridgeRejected,
        tokenConfigured: (await bridgeToken()).length > 0,
        tokenSource: await tokenSource(),
        pairingHint: processHint,
      });
    })();
    return true;
  }

  return undefined;
});

function onRelayReady(tabId: number, sender: chrome.runtime.MessageSender, announcedUrl: string | undefined): void {
  attachedTabs.add(tabId);
  const frameId = sender.frameId ?? 0;
  if (frameId === 0 && sender.documentId && topDocument.get(tabId) !== sender.documentId) {
    // A new top document (a reload, plain or not): the frames of the old one are gone.
    if (topDocument.has(tabId)) {
      tabFrames.delete(tabId);
      activeFrame.delete(tabId);
    }
    topDocument.set(tabId, sender.documentId);
    persistSession();
  }
  let frames = tabFrames.get(tabId);
  if (!frames) tabFrames.set(tabId, (frames = new Map()));
  const url = announcedUrl ?? sender.url ?? '';
  if (!frames.has(frameId) || frames.get(frameId) !== url) {
    frames.set(frameId, url);
    persistSession();
    emit(Events.tabsChanged, { tabId, attached: true, frameId });
  }

  const trace = pendingTraces.get(tabId);
  if (trace && frameId === 0 && sender.documentId !== trace.armedIn && sender.documentId !== trace.document) {
    // The first top document after the arm is the reload it asked for; any later one, or one on
    // another site, means the intent is spent.
    if (trace.document === undefined && originOf(sender.url) === trace.origin) trace.document = sender.documentId;
    else pendingTraces.delete(tabId);
    persistSession();
  }
  const pending = pendingTraces.get(tabId);
  if (pending?.document !== undefined) {
    // Best effort and deliberately fire-and-forget: the page may still instantiate first,
    // and the trace status reports that honestly.
    void sendToTab(tabId, 'page.trace.arm', pending.options, 5_000, frameId).catch(() => undefined);
  }
}

/** Extension pages only (panel, popup, the panel opened as a tab), never a content script. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.url?.startsWith(chrome.runtime.getURL('')) === true;
}

/** Same normalisation the bridge response uses, so a panel sees the identical code and message. */
function errorReply(error: unknown): { error: BridgeErrorShape } {
  return { error: makeErrorResponse('panel', error).error ?? { code: 'INTERNAL', message: String(error) } };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await sessionReady;
  forgetDocument(tabId);
  topDocument.delete(tabId);
  pendingTraces.delete(tabId);
});

// A new document means new frames and a new page agent, so forget the routing and re-probe on the
// next call. Nothing else has to happen: there is no grant to revoke. This only catches a URL change;
// a plain reload is caught by the new top document's relay announcing itself (onRelayReady).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' || !changeInfo.url) return;
  await sessionReady;
  forgetDocument(tabId);
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener((details) => {
  connect();
  // Someone who just pressed Load unpacked has no idea where the panel is; say it once, in the
  // background so the tab they were on keeps focus. Updates and reloads stay quiet.
  if (details.reason === 'install') void chrome.tabs.create({ url: 'welcome.html', active: false });
});

// Keep trying to reach the local bridge for as long as the worker is alive. The alarm (30s is
// Chrome's minimum period) wakes a suspended worker and redials, so the bridge comes back on its own.
connect();
void chrome.alarms.create('wasmcheat-bridge-keepalive', { periodInMinutes: KEEPALIVE_MS / 60_000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wasmcheat-bridge-keepalive') void connect();
});
