/**
 * DevTools panel: the whole bridge, driven by a human.
 *
 * Every call goes through the service worker's `wasmcheat.panel.call` family, which reuses the
 * very dispatcher the WebSocket uses. That is deliberate: frame routing,
 * worker routing and error shapes are identical to what an MCP client sees, so this panel is a
 * second front end rather than a trust bypass.
 */
import {
  BridgeError,
  type Bookmark,
  type SavedScanSummary,
  PATCH_MODES,
  SCAN_MODES,
  TRACE_KINDS,
  VALUE_TYPES,
  formatAddress,
  isBridgeError,
  parseAddress,
  type Address,
  type ErrorCode,
  type FreezeEntry,
  type HookEntry,
  type HookFallbackMode,
  type InstanceInfo,
  type PageAgentInfo,
  type PageDiagnostics,
  type PatchEntry,
  type PointerPath,
  type PointerResolution,
  type ReadResult,
  type ScanHit,
  type ScanMode,
  type ScanSummary,
  type SpeedStatus,
  type TabInfo,
  type TextEncoding,
  type TextScanResult,
  type TraceKind,
  type ValueType,
  type WatchEntry,
  type WatchEvent,
  type WorkerInfo,
  type WriteResult,
  type WriteTraceStatus,
} from '@wasmcheat/protocol';

import { installPanelHelp } from './panel-help.js';

// ---------------------------------------------------------------- element access

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`panel.html is missing #${id}`);
  return found as T;
}

const ADDRESS_FIELDS = ['mem-address', 'freeze-address', 'watch-address', 'trace-address'];
const INSTANCE_FIELDS = ['scan-instance', 'text-instance', 'hook-instance'];

// ---------------------------------------------------------------- state

/**
 * The tab DevTools is attached to. `chrome.devtools` only exists on a DevTools page; the panel is
 * also opened directly (tests, a pinned tab), where the tab list is the only way to pick a target.
 */
function inspectedTabId(): number | undefined {
  const devtools = (chrome as unknown as { devtools?: { inspectedWindow?: { tabId?: number } } })
    .devtools;
  const tabId = devtools?.inspectedWindow?.tabId;
  return typeof tabId === 'number' ? tabId : undefined;
}

/**
 * The panel drives the tab it was opened on. Opened through DevTools that tab is known outright; opened
 * as a plain page (a test, or someone bookmarked panel.html) fall back to the tab in front, which is
 * the one the human is looking at anyway.
 */
function isWebUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

async function frontTab(): Promise<TabInfo | undefined> {
  const inspected = inspectedTabId();
  try {
    const tabs = await swCall<TabInfo[]>('ext.listTabs');
    const known = tabs.find((tab) => tab.tabId === inspected);
    if (known) return known;
  } catch {
    // The service worker may still be waking up; the pills report that separately.
  }
  try {
    const tabs = (await swCall<TabInfo[]>('ext.listTabs')).filter((tab) => isWebUrl(tab.url));
    // A panel opened as a tab is itself the active tab, and extension pages are not targets.
    const active = tabs.find((tab) => tab.active);
    if (active) return active;
    const attached = tabs.find((tab) => tab.agentAttached);
    return attached ?? tabs[0];
  } catch {
    return undefined;
  }
}

let targetTabId: number | undefined = inspectedTabId();
/** Title and URL of the target, so the header can name it instead of saying "a tab". */
let frontTabInfo: TabInfo | undefined;
let selectedInstanceId: string | undefined;
let activeScanId: string | undefined;

// ---------------------------------------------------------------- messaging

interface PanelReply {
  result?: unknown;
  error?: { code?: string; message?: string; detail?: unknown };
}

interface PingReply {
  ok: boolean;
  extension: string;
  protocol: number;
  bridgeConnected?: boolean;
  /** The server closed us with 1008: the token it expected is not the one stored here. */
  bridgeRejected?: boolean;
  tokenConfigured?: boolean;
  tokenSource?: 'paired' | 'pasted' | 'none';
  pairingHint?: string;
}

/** One transport for both families: `page.*` goes through `ext.call`, `ext.*` goes direct. */
async function swCall<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ type: 'wasmcheat.panel.call', method, params })) as
    | PanelReply
    | undefined;
  if (!reply) throw new BridgeError('INTERNAL', `the service worker gave no answer to ${method}`);
  if (reply.error) {
    throw new BridgeError(
      (reply.error.code ?? 'INTERNAL') as ErrorCode,
      reply.error.message ?? `${method} failed`,
      reply.error.detail,
    );
  }
  return reply.result as T;
}

function requireTab(): number {
  if (targetTabId === undefined) {
    throw new BridgeError('NO_TAB', 'no target tab: click a row in the Tabs section');
  }
  return targetTabId;
}

/** Page methods travel as `ext.call`, so frame routing and the audit funnel apply unchanged. */
function pageCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return swCall<T>('ext.call', { tabId: requireTab(), method, params });
}

function paramsObject(params: unknown, method: string): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new BridgeError('BAD_PARAMS', `${method} params must be a JSON object`);
  }
  return params as Record<string, unknown>;
}

/** `page.*` travels as `ext.call` so every front-end goes through the same dispatcher and audit funnel. */
function dispatch(method: string, params: unknown): Promise<unknown> {
  return method.startsWith('page.')
    ? pageCall(method, normalizePageParams(method, paramsObject(params, method)))
    : swCall(method, params);
}

/**
 * Typed JSON is exactly what the body-based page methods take, with one exception worth smoothing:
 * `address` is an object on the wire but a human types `w1:0x408` in the console, the same spelling
 * the MCP server accepts. `page.trace.arm` keeps the string because it re-parses it after a reload.
 */
function normalizePageParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const raw = params.address;
  if (method === 'page.trace.arm' || typeof raw !== 'string') return params;
  return { ...params, address: parseAddressText(raw) };
}

// ---------------------------------------------------------------- formatting

function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (isBridgeError(error)) return new BridgeError(error.code, error.message);
  return new BridgeError('INTERNAL', error instanceof Error ? error.message : String(error));
}

function describeError(error: unknown): string {
  const bridge = asBridgeError(error);
  return bridge.detail === undefined
    ? `${bridge.code}: ${bridge.message}`
    : `${bridge.code}: ${bridge.message}\n${stringify(bridge.detail)}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function compact(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function report(out: HTMLElement, text: string, isError = false): void {
  out.textContent = text;
  out.classList.toggle('is-error', isError);
  // An empty report means "the action worked and has nothing to say", which is the common case for
  // a refresh. An empty line of grey text is noise, so hide the line entirely.
  out.hidden = text.trim() === '';
}

/**
 * The single place every button reports. Nothing is swallowed: success text comes from the
 * handler, failure text is the bridge's own `code: message`.
 */
async function run(out: HTMLElement, action: () => Promise<string>): Promise<void> {
  try {
    report(out, await action());
  } catch (error) {
    report(out, describeError(error), true);
  }
}

/**
 * Missing ids are skipped, not fatal: the panel is edited often, and one removed button must never
 * take the whole surface down before it renders.
 */
function bind(id: string, out: HTMLElement, action: () => Promise<string>): void {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) {
    console.warn(`panel.html is missing #${id}; that action is unavailable`);
    return;
  }
  button.addEventListener('click', () => {
    void run(out, action);
  });
}

// ---------------------------------------------------------------- field helpers

function parseNumber(text: string, label: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new BridgeError('BAD_PARAMS', `${label} "${text}" is not a number`);
  return value;
}

function num(field: HTMLInputElement, label: string): number {
  const raw = field.value.trim();
  if (!raw) throw new BridgeError('BAD_PARAMS', `${label} is empty`);
  return parseNumber(raw, label);
}

function fieldNum(id: string, label: string): number {
  return num(el<HTMLInputElement>(id), label);
}

function optionalFieldNum(id: string, label: string): number | undefined {
  return el<HTMLInputElement>(id).value.trim() ? fieldNum(id, label) : undefined;
}

/** `w1:0x408` passes through; a bare offset borrows the instance picked in the Instances table. */
function address(field: HTMLInputElement): string {
  const raw = field.value.trim();
  if (!raw) throw new BridgeError('BAD_PARAMS', 'address is empty');
  if (/^[A-Za-z0-9_-]+:/.test(raw)) return raw;
  if (!selectedInstanceId) {
    throw new BridgeError('BAD_PARAMS', `"${raw}" has no <instanceId>: prefix — click Use on an instance first`);
  }
  return `${selectedInstanceId}:${raw}`;
}

function parseAddressText(text: string): Address {
  try {
    return parseAddress(text);
  } catch (error) {
    throw new BridgeError('BAD_PARAMS', error instanceof Error ? error.message : String(error));
  }
}

/** The page side wants a parsed `Address`; humans type `w1:0x408`, so the parse happens here. */
function addressAt(field: HTMLInputElement): Address {
  return parseAddressText(address(field));
}

function fillAddress(text: string): void {
  for (const id of ADDRESS_FIELDS) el<HTMLInputElement>(id).value = text;
}

function selectInstance(id: string): void {
  selectedInstanceId = id;
  for (const fieldId of INSTANCE_FIELDS) el<HTMLInputElement>(fieldId).value = id;
}

let knownInstances: InstanceInfo[] = [];

/**
 * The instance field is a text box so a power user can type an id, but the normal path is Use on a
 * row. When it is empty the refusal has to say which of the two problems it is: a page with no wasm
 * (nothing to pick) or a page with several (nothing picked yet).
 */
function instanceFrom(fieldId: string): string {
  const id = el<HTMLInputElement>(fieldId).value.trim();
  if (id) return id;
  if (knownInstances.length === 0) {
    throw new BridgeError(
      'BAD_PARAMS',
      'no WebAssembly instance is loaded in this tab yet, so there is nothing to point at — press Diagnose to see why (the game may start on a click, sit in an iframe, or run in a worker)',
    );
  }
  const ids = knownInstances.map((instance) => instance.id).join(', ');
  throw new BridgeError('BAD_PARAMS', `pick an instance first: press Use on a row under Instances (${ids})`);
}

function requireInstance(): string {
  return instanceFrom('scan-instance');
}

function fillSelect(select: HTMLSelectElement, values: readonly string[], selected?: string): void {
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  if (selected !== undefined) select.value = selected;
}

function selectOf(id: string): HTMLSelectElement {
  return el<HTMLSelectElement>(id);
}

function typeOf(id: string): ValueType {
  return selectOf(id).value as ValueType;
}

// ---------------------------------------------------------------- list building

function span(text: string, className?: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function addressLink(text: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = text;
  button.title = 'Fill this address into the forms and show it in the memory viewer';
  button.addEventListener('click', () => {
    fillAddress(text);
    // A hit in a scan list is a place to look, not just a value to copy: jumping the viewer here is
    // what makes a hex dump usable without retyping addresses.
    void jumpViewer(text).catch((error: unknown) => {
      const output = document.getElementById('viewer-out');
      if (output) output.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  return button;
}

function miniButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function listItem(parts: (string | HTMLElement)[]): HTMLLIElement {
  const item = document.createElement('li');
  for (const part of parts) item.append(typeof part === 'string' ? span(part) : part);
  return item;
}

function renderList(host: HTMLElement, items: HTMLLIElement[], emptyText: string): void {
  host.replaceChildren(...(items.length ? items : [listItem([span(emptyText, 'empty')])]));
}

// ---------------------------------------------------------------- status bar

function setPill(id: string, text: string, tone: 'idle' | 'live' | 'warn' | 'bad'): void {
  const pill = el(id);
  pill.className = `pill pill--${tone}`;
  pill.textContent = text;
}

function reportStatusError(error: unknown): void {
  const out = el<HTMLPreElement>('status-out');
  report(out, describeError(error), true);
}

async function refreshStatus(): Promise<void> {
  const statusOut = el<HTMLPreElement>('status-out');
  statusOut.hidden = true;
  statusOut.classList.remove('is-error');

  const ping = await swCall<PingReply>('ext.ping');
  setPill(
    'bridge',
    ping.bridgeConnected ? 'bridge live' : 'bridge offline (retrying)',
    ping.bridgeConnected ? 'live' : 'idle',
  );
  el('versions').textContent = `extension ${ping.extension} · protocol ${ping.protocol}`;
  // The token is meant to be invisible: pairing fetches it on first connect. Only say anything when
  // the human actually has to act.
  const summary = el('token-summary');
  summary.textContent =
    ping.tokenSource === 'paired'
      ? 'Bridge · paired with this machine (nothing to paste; open only to override)'
      : 'Bridge token';
  if (ping.bridgeRejected) setPill('bridge', 'token refused', 'bad');
  else if (ping.tokenSource === 'paired') setPill('bridge', 'bridge live', 'live');
  else if (!ping.tokenConfigured) setPill('bridge', 'waiting for pairing', 'warn');
  if (ping.pairingHint && !ping.bridgeConnected) setPill('bridge', ping.pairingHint, 'warn');

  if (targetTabId === undefined) {
    const front = await frontTab();
    if (front) {
      targetTabId = front.tabId;
      frontTabInfo = front;
    }
  }
  const tabId = targetTabId;
  if (tabId === undefined) {
    el('target').textContent = 'no inspected tab: open this panel from DevTools on the page you want';
    setPill('tab-state', 'no tab', 'idle');
    setPill('agent', 'agent ?', 'idle');
    markStep(1);
    return;
  }
  markStep(activeScanId === undefined ? 2 : 3);
  setPill('tab-state', 'this tab', 'live');
  if (frontTabInfo) {
    el('target').textContent = `${frontTabInfo.title || frontTabInfo.url} · ${frontTabInfo.url}`;
    el('target').classList.remove('process--empty');
  }

  try {
    const info = await swCall<PageAgentInfo>('ext.call', {
      tabId,
      method: 'page.hello',
      params: {},
    });
    setPill(
      'agent',
      info.evalAllowed ? 'agent ready' : 'agent ready · scripts blocked',
      info.evalAllowed ? 'live' : 'warn',
    );
  } catch {
    setPill('agent', 'not attached yet', 'idle');
    report(statusOut, 'this tab has no page agent yet: press Attach', false);
  }
}

/**
 * Attach, then say what the human can do next. "Attached" alone is useless: the question everyone
 * has after attaching is "where is the game", so the instance table is filled and, when it is empty,
 * Diagnose is quoted instead of making them press another button.
 */
function attachAndReport(reload: boolean): () => Promise<string> {
  return async () => {
    const tabId = requireTab();
    const agent = await swCall<PageAgentInfo>('ext.ensureAgent', { tabId, reload });
    await refreshStatus();
    await refreshInstances();
    const reloaded = agent.autoReloaded === true && !reload;
    const lines = [
      `agent ${agent.version} attached to tab ${tabId} · eval ${
        agent.evalAllowed ? 'allowed' : 'blocked by page CSP'
      }${reload ? ' · after a reload' : reloaded ? ' · the tab was reloaded for you' : ''}`,
      `instances: ${knownInstances.length === 0 ? 'none yet' : knownInstances.map((instance) => instance.id).join(', ')}`,
    ];
    if (knownInstances.length === 0) {
      lines.push('', await diagnose().catch((error: unknown) => String(error)));
      lines.push('', 'If the game only starts on a click, start it and press Reload & attach.');
    }
    return lines.join('\n');
  };
}

let statusTimer: number | undefined;

/** Events arrive in bursts (a reload emits several); one refresh per burst is enough. */
function scheduleStatusRefresh(): void {
  if (statusTimer !== undefined) return;
  statusTimer = window.setTimeout(() => {
    statusTimer = undefined;
    void refreshStatus().catch(reportStatusError);
  }, 120);
}

// ---------------------------------------------------------------- instances

async function instanceList(): Promise<InstanceInfo[]> {
  const list = await pageCall<InstanceInfo[]>('page.listInstances');
  return Array.isArray(list) ? list : [];
}

function renderInstances(instances: InstanceInfo[]): void {
  knownInstances = instances;
  const body = el<HTMLTableSectionElement>('instances-body');
  const rows = instances.map((instance) => {
    const row = document.createElement('tr');
    row.append(
      cell(instance.id),
      cell(instance.moduleHash ?? '—'),
      cell(
        instance.memory
          ? `${instance.memory.byteLength} B${instance.memory.growable ? ' growable' : ''}`
          : instance.memoryResolved
            ? 'no memory export'
            : 'unresolved',
      ),
      cell(instance.importPatchability),
      cell(instance.host === 'worker' ? `worker ${instance.workerId ?? '?'}` : 'page'),
      cell(miniButton('Use', () => selectInstance(instance.id))),
    );
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const only = cell(
      'No wasm instance here. Press Diagnose: it reports whether this page called instantiate at all, and whether the game is in a frame or a worker.',
    );
    only.colSpan = 6;
    row.append(only);
    rows.push(row);
  }
  body.replaceChildren(...rows);

  const single = instances.length === 1 ? instances[0] : undefined;
  if (single && selectedInstanceId === undefined) selectInstance(single.id);
}

function cell(content: string | HTMLElement): HTMLTableCellElement {
  const element = document.createElement('td');
  if (typeof content === 'string') element.textContent = content;
  else element.append(content);
  return element;
}

async function refreshInstances(): Promise<string> {
  const instances = await instanceList();
  renderInstances(instances);
  return instances.length
    ? `${instances.length} instance(s): ${instances.map((instance) => instance.id).join(', ')}`
    : 'No instances yet. Press Refresh; if it stays empty, press Diagnose to see why.';
}

async function diagnose(): Promise<string> {
  const info = await pageCall<PageDiagnostics>('page.diagnose');
  // The hint goes first: it is the one line that tells a human what to do next.
  return [
    info.hint,
    `url: ${info.url}${info.frameId === undefined ? '' : ` (frame ${info.frameId})`}`,
    `readyState: ${info.readyState} · agent ${info.version} · ${info.agentAgeMs} ms old · eval ${
      info.evalAllowed ? 'allowed' : 'blocked'
    }`,
    `instances: ${info.instances} · canvases: ${info.canvases} · iframes: ${info.iframes.length}`,
    `calls: ${compact(info.calls)}`,
    `iframes: ${compact(info.iframes)}`,
    `wasm references: ${info.wasmReferences.join(', ') || 'none'}`,
  ].join('\n');
}

// ---------------------------------------------------------------- reads and writes

function describeValues(result: ReadResult): string {
  const values = result.values.join(', ');
  return result.hex ? `${values} (${result.values.length} bytes)\nhex ${result.hex}` : values;
}

async function readOne(): Promise<string> {
  const result = await pageCall<ReadResult>('page.read', {
    address: addressAt(el('mem-address')),
    type: typeOf('mem-type'),
  });
  return `${formatAddress(result.address)} ${result.type} = ${describeValues(result)}`;
}

async function readMany(): Promise<string> {
  const result = await pageCall<ReadResult>('page.read', {
    address: addressAt(el('mem-address')),
    type: typeOf('mem-type'),
    count: fieldNum('mem-count', 'count'),
  });
  return `${formatAddress(result.address)} ${result.type}[${result.values.length}] = ${describeValues(result)}`;
}

async function readBytes(): Promise<string> {
  const result = await pageCall<ReadResult>('page.read', {
    address: addressAt(el('mem-address')),
    type: 'u8',
    length: fieldNum('mem-length', 'bytes'),
    encoding: 'hex',
  });
  return `${formatAddress(result.address)} ${result.values.length} byte(s)\nhex ${result.hex ?? ''}`;
}

// ---------------------------------------------------------------- memory viewer

const VIEWER_BYTES_PER_ROW = 16;
let viewer: { instanceId: string; offset: number } | null = null;

function twoDigitHex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/**
 * Dumps memory the way a hex editor does: address, sixteen bytes, then the printable characters.
 * Every row reuses one `page.read` of the whole block, so panning does not fire a call per row.
 */
async function viewMemory(direction: 0 | -1 | 1 = 0): Promise<string> {
  const rows = Math.min(64, Math.max(1, fieldNum('viewer-rows', 'rows')));
  if (direction === 0 || viewer === null) {
    const parsed = parseAddress(el<HTMLInputElement>('viewer-address').value.trim());
    viewer = { instanceId: parsed.instanceId, offset: parsed.offset };
  } else {
    viewer = {
      instanceId: viewer.instanceId,
      offset: Math.max(0, viewer.offset + direction * rows * VIEWER_BYTES_PER_ROW),
    };
    el<HTMLInputElement>('viewer-address').value = formatAddress(viewer);
  }
  const start = viewer;
  const result = await pageCall<ReadResult>('page.read', {
    address: start,
    type: 'u8',
    length: rows * VIEWER_BYTES_PER_ROW,
    encoding: 'hex',
  });
  const bytes = result.values as number[];
  const lines: string[] = [];
  for (let row = 0; row * VIEWER_BYTES_PER_ROW < bytes.length; row += 1) {
    const offset = row * VIEWER_BYTES_PER_ROW;
    const slice = bytes.slice(offset, offset + VIEWER_BYTES_PER_ROW);
    const cells = slice.map(twoDigitHex).join(' ');
    const ascii = slice
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(
      `${formatAddress({ instanceId: start.instanceId, offset: start.offset + offset })}  ${cells.padEnd(47, ' ')}  |${ascii}|`,
    );
  }
  return lines.join('\n') || '(nothing to show)';
}

/** Points the viewer at an address and re-renders it: what every address link in the panel does. */
async function jumpViewer(text: string): Promise<void> {
  el<HTMLInputElement>('viewer-address').value = text;
  const output = document.getElementById('viewer-out');
  if (!output) return;
  output.textContent = await viewMemory(0);
}

/**
 * Reads the 32-bit pointer stored at the viewer's address and follows it, because a pointer chain is
 * how an address survives a reload: the dump can walk it without an agent.
 */
async function followPointer(): Promise<string> {
  const from = viewer ?? parseAddress(el<HTMLInputElement>('viewer-address').value.trim());
  const read = await pageCall<ReadResult>('page.read', { address: from, type: 'u32' });
  const next = { instanceId: from.instanceId, offset: (read.values as number[])[0] ?? 0 };
  el<HTMLInputElement>('viewer-address').value = formatAddress(next);
  return viewMemory(0);
}

async function listWorkers(): Promise<string> {
  const workers = await pageCall<WorkerInfo[]>('page.listWorkers', {});
  if (workers.length === 0) return 'no workers have instantiated wasm in this page';
  return workers
    .map(
      (worker) =>
        `${worker.id}  ${worker.type.padEnd(6)}  ${worker.instances} instance(s)  ${worker.url || '(no url)'}`,
    )
    .join('\n');
}

async function scanPointers(): Promise<string> {
  const target = parseAddress(el<HTMLInputElement>('ptr-address').value.trim());
  const maxDepth = Math.min(6, Math.max(1, fieldNum('ptr-depth', 'depth')));
  const maxOffset = Math.max(4, fieldNum('ptr-max-offset', 'max offset'));
  const paths = await pageCall<PointerPath[]>('page.pointer.scan', {
    instanceId: target.instanceId,
    offset: target.offset,
    maxDepth,
    maxOffset,
  });
  if (paths.length === 0) {
    return `no chain reaches ${formatAddress(target)} within ${maxDepth} hop(s) and ${maxOffset} bytes per hop - raise either bound`;
  }
  const header = `${paths.length} chain(s), shortest first`;
  return [header, ...paths
    .map(
      (path, index) =>
        `${index + 1}. [${formatAddress(path.base)}] = ${path.baseValue} + ${path.offsets.join(' + ')} -> ${formatAddress(path.target)}   (paste "${formatAddress(path.base)} ${path.offsets.join(',')}")`,
    ),
  ].join('\n');
}

async function resolvePointer(): Promise<string> {
  const raw = el<HTMLInputElement>('ptr-path').value.trim();
  const [addressText, offsetText = ''] = raw.split(/\s+/);
  if (!addressText) throw new BridgeError('BAD_PARAMS', 'paste a path like "w1:0x2af2730 16,8"');
  const base = parseAddress(addressText);
  const offsets = offsetText
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
  if (offsets.length === 0 || offsets.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new BridgeError('BAD_PARAMS', 'offsets look like "16,8"');
  }
  const resolution = await pageCall<PointerResolution>('page.pointer.resolve', {
    instanceId: base.instanceId,
    base: base.offset,
    offsets,
  });
  const hops = resolution.hops
    .map((hop, index) => `${index + 1}. ${hop.address} = ${hop.value}`)
    .join('\n');
  return `${hops}\nfinal ${resolution.final} = ${resolution.value === null ? '(left memory)' : resolution.value}`;
}

async function applySpeed(scale: number): Promise<string> {
  const status = await pageCall<SpeedStatus>('page.speed.set', { scale });
  return `${status.scale}x ${status.scale === 1 ? '(real time)' : 'simulated time'}`;
}

async function writeValue(): Promise<string> {
  const result = await pageCall<WriteResult>('page.write', {
    address: addressAt(el('mem-address')),
    type: typeOf('mem-type'),
    value: fieldNum('mem-value', 'value'),
  });
  return `${formatAddress(result.address)} ${result.type}: ${result.before} -> ${result.after}`;
}

// ---------------------------------------------------------------- freeze

function renderFreezes(entries: FreezeEntry[]): void {
  const items = entries.map((entry) =>
    listItem([
      entry.id,
      addressLink(formatAddress(entry.address)),
      `${entry.type}=${entry.value}`,
      miniButton('Clear', () => {
        void run(el('freeze-out'), async () => {
          await pageCall<boolean>('page.freeze.clear', { freezeId: entry.id });
          renderFreezes(await pageCall<FreezeEntry[]>('page.freeze.list'));
          return `${entry.id} cleared`;
        });
      }),
    ]),
  );
  renderList(el('freezes'), items, 'Nothing frozen. Click an address in Found, then press Set freeze.');
}

async function freezeSet(): Promise<string> {
  const entry = await pageCall<FreezeEntry>('page.freeze.set', {
    address: addressAt(el('freeze-address')),
    type: typeOf('freeze-type'),
    value: fieldNum('freeze-value', 'value'),
  });
  renderFreezes(await pageCall<FreezeEntry[]>('page.freeze.list'));
  return `frozen ${entry.id} · ${formatAddress(entry.address)} ${entry.type}=${entry.value}`;
}

async function freezeClear(): Promise<string> {
  const id = el<HTMLInputElement>('freeze-id').value.trim();
  if (!id) throw new BridgeError('BAD_PARAMS', 'freeze id is empty');
  const cleared = await pageCall<boolean>('page.freeze.clear', { freezeId: id });
  renderFreezes(await pageCall<FreezeEntry[]>('page.freeze.list'));
  return cleared ? `${id} cleared` : `${id} was not frozen`;
}

async function freezeList(): Promise<string> {
  const entries = await pageCall<FreezeEntry[]>('page.freeze.list');
  renderFreezes(entries);
  return `${entries.length} freeze(s)`;
}

// ---------------------------------------------------------------- watch

function renderWatches(entries: WatchEntry[]): void {
  const items = entries.map((entry) =>
    listItem([
      entry.id,
      addressLink(formatAddress(entry.address)),
      `${entry.type} last=${entry.lastValue}`,
      miniButton('Remove', () => {
        void run(el('watch-out'), async () => {
          await pageCall<boolean>('page.watch.remove', { watchId: entry.id });
          renderWatches(await pageCall<WatchEntry[]>('page.watch.list'));
          return `${entry.id} removed`;
        });
      }),
    ]),
  );
  renderList(el('watches'), items, 'No watches. Enter an address and a type, then press Add watch.');
}

function renderWatchEvents(events: WatchEvent[]): void {
  const newestFirst = [...events].sort((a, b) => b.at - a.at);
  const items = newestFirst.map((event) =>
    listItem([
      clock(event.at),
      event.watchId,
      addressLink(formatAddress(event.address)),
      `${event.before} -> ${event.after}`,
    ]),
  );
  renderList(el('watch-events'), items, 'No changes recorded. Poll again after the page has run for a moment.');
}

async function watchAdd(): Promise<string> {
  const entry = await pageCall<WatchEntry>('page.watch.add', {
    address: addressAt(el('watch-address')),
    type: typeOf('watch-type'),
  });
  renderWatches(await pageCall<WatchEntry[]>('page.watch.list'));
  return `watching ${entry.id} · ${formatAddress(entry.address)} ${entry.type} (start ${entry.lastValue})`;
}

async function watchRemove(): Promise<string> {
  const id = el<HTMLInputElement>('watch-id').value.trim();
  if (!id) throw new BridgeError('BAD_PARAMS', 'watch id is empty');
  const removed = await pageCall<boolean>('page.watch.remove', { watchId: id });
  renderWatches(await pageCall<WatchEntry[]>('page.watch.list'));
  return removed ? `${id} removed` : `${id} was not watched`;
}

async function watchList(): Promise<string> {
  const entries = await pageCall<WatchEntry[]>('page.watch.list');
  renderWatches(entries);
  return `${entries.length} watch(es)`;
}

async function watchPoll(): Promise<string> {
  const events = await pageCall<WatchEvent[]>('page.watch.poll', {});
  renderWatchEvents(events);
  return events.length ? `${events.length} event(s), newest first` : 'no watch events since the last poll';
}

// ---------------------------------------------------------------- scan

function scanRange(): { start: number; end: number } | undefined {
  const startText = el<HTMLInputElement>('scan-start').value.trim();
  const endText = el<HTMLInputElement>('scan-end').value.trim();
  if (!startText && !endText) return undefined;
  if (!startText || !endText) {
    throw new BridgeError('BAD_PARAMS', 'scan range needs both from and to, or neither');
  }
  return { start: parseNumber(startText, 'range from'), end: parseNumber(endText, 'range to') };
}

/** Shared by Begin and Narrow: the compare fields mean the same thing in both passes. */
function scanCompareParams(mode: ScanMode): Record<string, unknown> {
  const params: Record<string, unknown> = { mode };
  const value = optionalFieldNum('scan-value', 'value');
  if (value !== undefined) params.value = value;
  if (mode === 'between') {
    const upper = optionalFieldNum('scan-value2', 'value2');
    if (upper === undefined) throw new BridgeError('BAD_PARAMS', 'mode "between" needs value2');
    params.value2 = upper;
  }
  return params;
}

/** Which of the three steps the human is on, so the strip is a position and not decoration. */
function markStep(step: 1 | 2 | 3): void {
  const nav = document.querySelector('nav.steps');
  if (!nav) return;
  for (const link of nav.querySelectorAll('a')) {
    const value = Number((link as HTMLElement).dataset.step);
    link.classList.toggle('is-current', value === step);
    link.classList.toggle('is-done', value < step);
  }
}

function markScanStep(step: 'first' | 'narrow'): void {
  // Only one filled button at a time, and it is always the next thing to press.
  el('scan-begin').classList.toggle('primary', step === 'first');
  el('scan-narrow').classList.toggle('primary', step === 'narrow');
}

/**
 * Hide the fields a mode does not use. A form that always shows every option teaches nothing about
 * which ones matter, and `between` is the only mode with two values.
 */
function syncScanFields(): void {
  const mode = selectOf('scan-mode').value;
  const valueField = el<HTMLInputElement>('scan-value').closest('label');
  const upperField = el<HTMLInputElement>('scan-value2').closest('label');
  if (upperField) upperField.hidden = mode !== 'between';
  // A value is optional for the delta modes (it narrows to "changed AND now equals N"); say so
  // instead of removing the field, because typing a target there is a real technique.
  const optional = ['changed', 'unchanged', 'increased', 'decreased'].includes(mode);
  el<HTMLInputElement>('scan-value').placeholder = optional ? 'optional' : 'the value on screen';
  if (valueField) valueField.classList.toggle('field--optional', optional);
}

function renderScanSummary(summary: ScanSummary): void {
  activeScanId = summary.scanId;
  markScanStep('narrow');
  el('scan-id').textContent = `scan ${summary.scanId} · ${summary.matchCount} match(es)`;
  const items = [...summary.sample]
    .sort((a, b) => a.address.offset - b.address.offset)
    .map((hit) => listItem([addressLink(formatAddress(hit.address)), String(hit.value)]));
  renderList(el('scan-hits'), items, 'No hits in this answer. Narrow again with Next Scan, or widen the byte range.');
}

function renderScanHits(hits: ScanHit[], total: number): void {
  const items = [...hits]
    .sort((a, b) => a.address.offset - b.address.offset)
    .map((hit) => listItem([addressLink(formatAddress(hit.address)), String(hit.value)]));
  renderList(el('scan-hits'), items, `no hits in the first ${hits.length} of ${total}`);
}

function requireScanId(): string {
  if (!activeScanId) throw new BridgeError('SCAN_CLOSED', 'no scan open — press Begin first');
  return activeScanId;
}

function scanSummaryLine(summary: ScanSummary, verb: string): string {
  return `${verb} ${summary.scanId} · ${summary.mode} ${summary.type} · ${summary.matchCount} match(es)${
    summary.truncated ? ' · truncated at maxResults' : ''
  } · memory ${summary.memoryByteLength} B`;
}

async function scanBegin(): Promise<string> {
  const mode = selectOf('scan-mode').value as ScanMode;
  const params: Record<string, unknown> = {
    instanceId: requireInstance(),
    type: typeOf('scan-type'),
    ...scanCompareParams(mode),
  };
  const alignment = selectOf('scan-alignment').value;
  if (alignment) params.alignment = Number(alignment);
  const range = scanRange();
  if (range) params.range = range;
  const maxResults = optionalFieldNum('scan-max', 'max results');
  if (maxResults !== undefined) params.maxResults = maxResults;

  const summary = await pageCall<ScanSummary>('page.scan.begin', params);
  renderScanSummary(summary);
  return scanSummaryLine(summary, 'began');
}

async function scanNarrow(): Promise<string> {
  const summary = await pageCall<ScanSummary>('page.scan.next', {
    scanId: requireScanId(),
    ...scanCompareParams(selectOf('scan-mode').value as ScanMode),
  });
  renderScanSummary(summary);
  return scanSummaryLine(summary, 'narrowed');
}

async function scanResults(): Promise<string> {
  const result = await pageCall<{ hits: ScanHit[]; total: number }>('page.scan.results', {
    scanId: requireScanId(),
    limit: 100,
  });
  renderScanHits(result.hits, result.total);
  return `${result.hits.length} of ${result.total} hit(s) shown`;
}

async function scanDrop(): Promise<string> {
  const id = requireScanId();
  const dropped = await pageCall<boolean>('page.scan.drop', { scanId: id });
  activeScanId = undefined;
  el('scan-id').textContent = 'no scan';
  markScanStep('first');
  renderList(el('scan-hits'), [], 'No scan yet. Press First Scan with a value you can see on the page; Next Scan then narrows that list.');
  return dropped ? `${id} dropped` : `${id} was already closed`;
}

async function bookmarkAdd(): Promise<string> {
  const label = el<HTMLInputElement>('bookmark-label').value.trim();
  const address = el<HTMLInputElement>('bookmark-address').value.trim();
  const bookmark = await pageCall<Bookmark>('page.bookmark.add', { label, address });
  await bookmarkList();
  return `bookmarked "${bookmark.label}" -> ${bookmark.address}`;
}

async function bookmarkList(): Promise<string> {
  const items = await pageCall<Bookmark[]>('page.bookmark.list');
  renderList(
    el('bookmark-list-out'),
    items.map((bookmark) =>
      listItem([
        span(bookmark.label),
        addressLink(bookmark.address),
        span(bookmark.type ?? '', 'empty'),
        miniButton('Forget', () => {
          void pageCall<boolean>('page.bookmark.remove', { id: bookmark.id }).then(bookmarkList);
        }),
      ]),
    ),
    'No bookmarks. Type an address and a label, then press Add bookmark.',
  );
  return items.length === 0 ? 'nothing bookmarked yet' : `${items.length} bookmark(s)`;
}

async function bookmarkClear(): Promise<string> {
  const { removed } = await pageCall<{ removed: number }>('page.bookmark.clear');
  await bookmarkList();
  return `cleared ${removed} bookmark(s)`;
}

async function savedList(): Promise<string> {
  const items = await pageCall<SavedScanSummary[]>('page.saved.list');
  renderList(
    el('saved-list-out'),
    items.map((item) => listItem([span(`${item.name} · ${item.matchCount} match(es) · ${item.mode} ${item.type}`)])),
    'No saved scans in this page. Save one before anything reloads it.',
  );
  return items.length === 0 ? 'nothing saved yet' : `${items.length} saved scan(s)`;
}

async function savedSave(): Promise<string> {
  const name = requireSavedName();
  const saved = await pageCall<SavedScanSummary>('page.saved.save', { name, scanId: requireScanId() });
  await savedList();
  return `saved "${saved.name}" · ${saved.matchCount} match(es)`;
}

async function savedOpen(): Promise<string> {
  const name = requireSavedName();
  const opened = await pageCall<{ scanId: string; summary: ScanSummary }>('page.saved.open', { name });
  activeScanId = opened.scanId;
  el('scan-id').textContent = `scan ${opened.scanId} · ${opened.summary.matchCount} match(es) (from "${name}")`;
  renderList(el('scan-hits'), [], 'No hits in this answer. Narrow again with Next Scan, or widen the byte range.');
  return `opened "${name}" as ${opened.scanId} · narrow it with the scan form above`;
}

async function savedDelete(): Promise<string> {
  const name = requireSavedName();
  const deleted = await pageCall<boolean>('page.saved.delete', { name });
  await savedList();
  return deleted ? `deleted "${name}"` : `no saved scan named "${name}"`;
}

function requireSavedName(): string {
  const name = el<HTMLInputElement>('saved-name').value.trim();
  if (!name) throw new BridgeError('BAD_PARAMS', 'type a name first');
  return name;
}

async function scanText(): Promise<string> {
  const text = el<HTMLInputElement>('text-value').value;
  if (!text) throw new BridgeError('BAD_PARAMS', 'text is empty');
  const instanceId = instanceFrom('text-instance');
  const result = await pageCall<TextScanResult>('page.scan.text', {
    instanceId,
    text,
    encoding: selectOf('text-encoding').value as TextEncoding,
    caseSensitive: el<HTMLInputElement>('text-case').checked,
  });
  const items = result.matches.map((offset) =>
    listItem([addressLink(`${instanceId}:0x${offset.toString(16)}`), `+${offset}`]),
  );
  renderList(el('text-hits'), items, `No match for "${text}". Try the case-insensitive box, or another encoding.`);
  return `${result.matches.length} of ${result.total} match(es) · ${result.encoding}${
    result.truncated ? ' · truncated' : ''
  } · memory ${result.memoryByteLength} B`;
}

// ---------------------------------------------------------------- watchpoints

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function traceLines(status: WriteTraceStatus, lastError: unknown): string {
  return [
    `armed: ${status.armed ? 'yes' : 'no'} · installed: ${status.installed ? 'yes' : 'no'}`,
    `address: ${status.address ?? '—'} · type: ${status.type ?? '—'} · kind: ${status.kind ?? '—'} · instance: ${
      status.instanceId ?? '—'
    }`,
    `hits: ${status.hits.length} · dropped: ${status.dropped}`,
    status.note ? `note: ${status.note}` : '',
    status.hits.length === 0 && lastError !== undefined
      ? `last status error: ${describeError(lastError)}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function renderTrace(status: WriteTraceStatus): void {
  const hits = [...status.hits].sort((a, b) => b.at - a.at);
  renderList(
    el('trace-hits'),
    hits.map((hit) =>
      listItem([
        clock(hit.at),
        hit.funcName ?? `wasm-function[${hit.funcIndex}]`,
        `${hit.previous} -> ${hit.value}`,
      ]),
    ),
    'No hits yet. Pick an address and a mode above, then press Run watchpoint.',
  );
  renderList(
    el('trace-functions'),
    status.functions.map((entry) =>
      listItem([entry.name ?? `wasm-function[${entry.funcIndex}]`, `${entry.hits} hit(s)`]),
    ),
    'No function touched that address yet. Reload the tab with the watchpoint armed, then play.',
  );
}

async function traceRun(): Promise<string> {
  const tabId = requireTab();
  const addressText = address(el('trace-address'));
  const kind = selectOf('trace-kind').value as TraceKind;
  const timeoutSeconds = fieldNum('trace-timeout', 'timeout');
  const armed = await pageCall<WriteTraceStatus>('page.trace.arm', { address: addressText, kind });

  // The arm lives in the page's sessionStorage, so it survives exactly one reload. Reloading is
  // what installs the instrumented module; the status read below then has the hits.
  await swCall('ext.reload', { tabId });

  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  let status = armed;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      status = await pageCall<WriteTraceStatus>('page.trace.status');
      if (status.installed && status.hits.length > 0) break;
    } catch (error) {
      // The reloaded page may not answer yet; remember it and keep polling.
      lastError = error;
    }
  }

  renderTrace(status);
  return traceLines(status, lastError);
}

async function traceStop(): Promise<string> {
  const status = await pageCall<WriteTraceStatus>('page.trace.stop');
  renderTrace(status);
  return traceLines(status, undefined);
}

async function traceClear(): Promise<string> {
  const status = await pageCall<WriteTraceStatus>('page.trace.clear');
  renderTrace(status);
  return traceLines(status, undefined);
}

// ---------------------------------------------------------------- patches

function renderPatches(entries: PatchEntry[]): void {
  const items = entries.map((entry) =>
    listItem([
      entry.id,
      entry.target,
      entry.mode + (entry.value === undefined ? '' : `=${entry.value}`),
      entry.applied ? `applied ×${entry.applications}` : 'pending reload',
      miniButton('Remove', () => {
        void run(el('patch-out'), async () => {
          await pageCall<PatchEntry[]>('page.patch.remove', { patchId: entry.id });
          renderPatches(await pageCall<PatchEntry[]>('page.patch.list'));
          return `${entry.id} removed`;
        });
      }),
    ]),
  );
  renderList(el('patches'), items, 'No patches. Choose a target and a mode, then press Add patch.');
}

async function patchAdd(): Promise<string> {
  const target = el<HTMLInputElement>('patch-target').value.trim();
  if (!target) throw new BridgeError('BAD_PARAMS', 'patch target is empty');
  const mode = selectOf('patch-mode').value;
  const params: Record<string, unknown> = { target, mode };
  const value = optionalFieldNum('patch-value', 'value');
  if (value !== undefined) params.value = value;
  const note = el<HTMLInputElement>('patch-note').value.trim();
  if (note) params.note = note;
  const entry = await pageCall<PatchEntry>('page.patch.add', params);
  renderPatches(await pageCall<PatchEntry[]>('page.patch.list'));
  return `${entry.id} ${entry.mode} ${entry.target} — reload to install it`;
}

async function patchList(): Promise<string> {
  const entries = await pageCall<PatchEntry[]>('page.patch.list');
  renderPatches(entries);
  return `${entries.length} patch(es)`;
}

async function patchRemove(): Promise<string> {
  const id = el<HTMLInputElement>('patch-id').value.trim();
  if (!id) throw new BridgeError('BAD_PARAMS', 'patch id is empty');
  await pageCall<PatchEntry[]>('page.patch.remove', { patchId: id });
  renderPatches(await pageCall<PatchEntry[]>('page.patch.list'));
  return `${id} removed`;
}

async function patchClear(): Promise<string> {
  await pageCall<PatchEntry[]>('page.patch.clear', {});
  renderPatches(await pageCall<PatchEntry[]>('page.patch.list'));
  return 'all patches cleared';
}

// ---------------------------------------------------------------- hooks

function renderHooks(entries: HookEntry[]): void {
  const items = entries.map((entry) =>
    listItem([
      entry.id,
      `${entry.target} ${entry.name}`,
      entry.enabled ? 'enabled' : 'disabled',
      entry.pending ? 'pending' : entry.fallbackUsed ? 'fallback' : 'script',
      `${entry.calls} call(s)`,
      entry.lastReturn === undefined || entry.lastReturn === null ? '' : `return ${compact(entry.lastReturn)}`,
      miniButton(entry.enabled ? 'Disable' : 'Enable', () => {
        void run(el('hook-out'), async () => {
          await pageCall<HookEntry>('page.hook.setEnabled', {
            hookId: entry.id,
            enabled: !entry.enabled,
          });
          renderHooks(await pageCall<HookEntry[]>('page.hook.list'));
          return `${entry.id} ${entry.enabled ? 'disabled' : 'enabled'}`;
        });
      }),
      miniButton('Remove', () => {
        void run(el('hook-out'), async () => {
          const removed = await pageCall<boolean>('page.hook.remove', { hookId: entry.id });
          renderHooks(await pageCall<HookEntry[]>('page.hook.list'));
          return removed ? `${entry.id} removed` : `${entry.id} was already gone`;
        });
      }),
    ]),
  );
  renderList(el('hooks'), items, 'No hooks. An export wrapper needs a JS body; an import wrapper applies at the next instantiation.');
}

async function hookAdd(): Promise<string> {
  const instanceId = instanceFrom('hook-instance');
  const name = el<HTMLInputElement>('hook-name').value.trim();
  if (!name) throw new BridgeError('BAD_PARAMS', 'hook name is empty');
  const params: Record<string, unknown> = {
    instanceId,
    target: selectOf('hook-target').value,
    name,
    body: el<HTMLTextAreaElement>('hook-body').value,
  };
  const fallbackMode = selectOf('hook-fallback-mode').value as HookFallbackMode | '';
  if (fallbackMode) {
    const fallback: { mode: HookFallbackMode; value?: number } = { mode: fallbackMode };
    const value = optionalFieldNum('hook-fallback-value', 'fallback value');
    if (value !== undefined) fallback.value = value;
    params.fallback = fallback;
  }
  const entry = await pageCall<HookEntry>('page.hook.add', params);
  renderHooks(await pageCall<HookEntry[]>('page.hook.list'));
  return `${entry.id} on ${entry.target} ${entry.name}${entry.pending ? ' (pending reload)' : ''}`;
}

async function hookList(): Promise<string> {
  const entries = await pageCall<HookEntry[]>('page.hook.list');
  renderHooks(entries);
  return `${entries.length} hook(s)`;
}

async function hookRemove(): Promise<string> {
  const id = el<HTMLInputElement>('hook-id').value.trim();
  if (!id) throw new BridgeError('BAD_PARAMS', 'hook id is empty');
  const removed = await pageCall<boolean>('page.hook.remove', { hookId: id });
  renderHooks(await pageCall<HookEntry[]>('page.hook.list'));
  return removed ? `${id} removed` : `${id} was already gone`;
}

async function hookToggle(): Promise<string> {
  const id = el<HTMLInputElement>('hook-id').value.trim();
  if (!id) throw new BridgeError('BAD_PARAMS', 'hook id is empty');
  const enabled = el<HTMLInputElement>('hook-enabled').checked;
  await pageCall<HookEntry>('page.hook.setEnabled', { hookId: id, enabled });
  renderHooks(await pageCall<HookEntry[]>('page.hook.list'));
  return `${id} ${enabled ? 'enabled' : 'disabled'}`;
}

// ---------------------------------------------------------------- audit

interface AuditReply {
  lines: unknown[];
  total: number;
  note: string;
}

async function readAudit(): Promise<string> {
  const limit = fieldNum('audit-limit', 'limit');
  const reply = await swCall<AuditReply>('ext.audit', { limit });
  el('audit-note').textContent = `${reply.note} — showing ${reply.lines.length} of ${reply.total}`;
  return reply.lines.length
    ? reply.lines.map((line) => compact(line)).join('\n')
    : 'no audit lines recorded by this worker yet';
}

// ---------------------------------------------------------------- raw console

async function rawSend(): Promise<string> {
  const method = el<HTMLInputElement>('raw-method').value.trim();
  if (!method) throw new BridgeError('BAD_PARAMS', 'method is empty');
  const text = el<HTMLTextAreaElement>('raw-params').value.trim();
  let params: unknown = {};
  if (text) {
    try {
      params = JSON.parse(text);
    } catch (error) {
      throw new BridgeError(
        'BAD_PARAMS',
        `params are not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const call = `> ${method} ${compact(params)}`;
  try {
    const result = await dispatch(method, params);
    return `${call}\n< ${stringify(result)}`;
  } catch (error) {
    throw new BridgeError(asBridgeError(error).code, `${call}\n! ${describeError(error)}`);
  }
}

// ---------------------------------------------------------------- live events

const EVENT_LOG_MAX = 200;

interface LoggedEvent {
  at: number;
  event: string;
  data: unknown;
}

const eventLog: LoggedEvent[] = [];
let eventsPaused = false;

function renderEventLog(): void {
  el('events-count').textContent = `${eventLog.length} event${eventLog.length === 1 ? '' : 's'}${
    eventsPaused ? ' (paused)' : ''
  }`;
  const items = eventLog.map((entry) =>
    listItem([clock(entry.at), entry.event, compact(entry.data)]),
  );
  renderList(el('event-log'), items, 'No events yet. Bridge and page events appear here as they happen.');
}

function logEvent(event: string, data: unknown): void {
  if (eventsPaused) return;
  eventLog.unshift({ at: Date.now(), event, data });
  if (eventLog.length > EVENT_LOG_MAX) eventLog.length = EVENT_LOG_MAX;
  renderEventLog();
}

/**
 * A connected port is how the service worker fans out bridge events. MV3 may still stop the
 * worker, so a closed port reconnects instead of leaving the log silently dead.
 */
function openEvents(): void {
  const port = chrome.runtime.connect({ name: 'wasmcheat.panel' });
  port.onMessage.addListener((message: unknown) => {
    const payload = message as { event?: unknown; data?: unknown } | null;
    if (!payload || typeof payload.event !== 'string') return;
    logEvent(payload.event, payload.data);
    if (payload.event === 'bridge.unauthorized') {
      const data = payload.data as { hint?: string } | null;
      setPill('bridge', 'token refused', 'bad');
      report(el('status-out'), data?.hint ?? 'the bridge refused this extension: paste the bridge token');
    }
    if (payload.event === 'tabs.changed') scheduleStatusRefresh();
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError keeps Chrome from reporting an unchecked runtime error for a closed port.
    void chrome.runtime.lastError;
    logEvent('panel.portclosed', { note: 'service worker went away; reconnecting' });
    window.setTimeout(openEvents, 1000);
  });
}

// ---------------------------------------------------------------- testability hooks

/**
 * Small surface for the e2e suite. It calls the same functions the buttons call, so a passing test
 * exercises the real path rather than a test-only shortcut.
 */
interface PanelTestHooks {
  attach(tabId?: number): Promise<unknown>;
  call(method: string, params?: unknown): Promise<unknown>;
}

function panelAttach(tabId?: number): Promise<unknown> {
  if (tabId !== undefined) targetTabId = tabId;
  return swCall('ext.ensureAgent', { tabId: requireTab() });
}

// ---------------------------------------------------------------- wiring

function wire(): void {
  fillSelect(selectOf('mem-type'), VALUE_TYPES, 'i32');
  fillSelect(selectOf('freeze-type'), VALUE_TYPES, 'i32');
  fillSelect(selectOf('watch-type'), VALUE_TYPES, 'i32');
  fillSelect(selectOf('scan-type'), VALUE_TYPES, 'i32');
  fillSelect(selectOf('scan-mode'), SCAN_MODES, 'exact');
  fillSelect(selectOf('trace-kind'), TRACE_KINDS, 'write');
  fillSelect(selectOf('patch-mode'), PATCH_MODES, 'stub');

  const statusOut = el('status-out');
  bind('refresh-status', statusOut, async () => {
    await refreshStatus();
    return '';
  });
  bind('attach', statusOut, attachAndReport(false));
  bind('attach-reload', statusOut, attachAndReport(true));
  bind('token-save', statusOut, async () => {
    const token = el<HTMLInputElement>('bridge-token').value.trim();
    if (!token) throw new BridgeError('BAD_PARAMS', 'paste the token printed by the MCP server first');
    // Saving is what fixes a refused bridge: the service worker watches this key and reconnects.
    await chrome.storage.local.set({ bridgeToken: token, bridgeTokenSource: 'pasted' });
    await refreshStatus();
    return 'token saved; reconnecting to the bridge';
  });

  bind('instances-refresh', el('instances-out'), refreshInstances);

  syncScanFields();
  selectOf('scan-mode').addEventListener('change', syncScanFields);
  for (const id of ['scan-value', 'scan-value2']) {
    el<HTMLInputElement>(id).addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      // Enter in a value field runs whichever scan is the next step, so the mouse stays out of it.
      el<HTMLButtonElement>(activeScanId === undefined ? 'scan-begin' : 'scan-narrow').click();
    });
  }
  bind('diagnose', el('diagnose-out'), diagnose);

  bind('mem-read', el('memory-out'), readOne);
  bind('mem-read-n', el('memory-out'), readMany);
  bind('mem-read-bytes', el('memory-out'), readBytes);
  bind('mem-write', el('memory-out'), writeValue);

  bind('speed-apply', el('speed-out'), () => applySpeed(fieldNum('speed-value', 'scale')));
  bind('speed-reset', el('speed-out'), () => applySpeed(1));

  bind('viewer-view', el('viewer-out'), () => viewMemory(0));
  bind('viewer-prev', el('viewer-out'), () => viewMemory(-1));
  bind('viewer-next', el('viewer-out'), () => viewMemory(1));
  bind('viewer-follow', el('viewer-out'), followPointer);
  bind('workers-list', el('workers-out'), listWorkers);
  bind('ptr-scan', el('ptr-out'), scanPointers);
  bind('ptr-resolve', el('ptr-out'), resolvePointer);

  bind('freeze-set', el('freeze-out'), freezeSet);
  bind('freeze-clear', el('freeze-out'), freezeClear);
  bind('freeze-list', el('freeze-out'), freezeList);

  bind('watch-add', el('watch-out'), watchAdd);
  bind('watch-remove', el('watch-out'), watchRemove);
  bind('watch-list', el('watch-out'), watchList);
  bind('watch-poll', el('watch-out'), watchPoll);

  bind('scan-begin', el('scan-out'), scanBegin);
  bind('scan-narrow', el('scan-out'), scanNarrow);
  bind('scan-results', el('scan-out'), scanResults);
  bind('scan-drop', el('scan-out'), scanDrop);
  bind('text-scan', el('text-out'), scanText);
  bind('saved-save', el('saved-out'), savedSave);
  bind('saved-list', el('saved-out'), savedList);
  bind('saved-open', el('saved-out'), savedOpen);
  bind('saved-delete', el('saved-out'), savedDelete);
  bind('bookmark-add', el('bookmark-out'), bookmarkAdd);
  bind('bookmark-list', el('bookmark-out'), bookmarkList);
  bind('bookmark-clear', el('bookmark-out'), bookmarkClear);

  bind('trace-run', el('trace-out'), traceRun);
  bind('trace-stop', el('trace-out'), traceStop);
  bind('trace-clear', el('trace-out'), traceClear);

  bind('patch-add', el('patch-out'), patchAdd);
  bind('patch-list', el('patch-out'), patchList);
  bind('patch-remove', el('patch-out'), patchRemove);
  bind('patch-clear', el('patch-out'), patchClear);

  bind('hook-add', el('hook-out'), hookAdd);
  bind('hook-list', el('hook-out'), hookList);
  bind('hook-remove', el('hook-out'), hookRemove);
  bind('hook-toggle', el('hook-out'), hookToggle);

  bind('audit-read', el('audit-out'), readAudit);

  bind('raw-send', el('raw-out'), rawSend);

  const pause = el<HTMLButtonElement>('events-pause');
  pause.addEventListener('click', () => {
    eventsPaused = !eventsPaused;
    pause.textContent = eventsPaused ? 'Resume' : 'Pause';
    renderEventLog();
  });

  renderList(el('event-log'), [], 'No events yet. Bridge and page events appear here as they happen.');
  openEvents();

  (window as unknown as { __panel: PanelTestHooks }).__panel = {
    attach: panelAttach,
    call: (method, params) => dispatch(method, params ?? {}),
  };

  installPanelHelp();

  void refreshStatus().catch(reportStatusError);
}

wire();
