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
  type ScriptResult,
  type ModEntry,
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

const ADDRESS_FIELDS = ['mem-address', 'freeze-address', 'watch-address', 'trace-address', 'bookmark-address', 'ptr-address'];
/** Picking a hit sets these to its type too, so Freeze or Watch never reads an f32 as an i32. */
const TYPE_FIELDS = ['mem-type', 'freeze-type', 'watch-type', 'bookmark-type'];
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
  return withInstance(field.value.trim());
}

function withInstance(raw: string): string {
  if (!raw) throw new BridgeError('BAD_PARAMS', 'address is empty');
  if (/^[A-Za-z0-9_-]+:/.test(raw)) return raw;
  if (!selectedInstanceId) {
    throw new BridgeError('BAD_PARAMS', `"${raw}" has no <instanceId>: prefix: click Use on an instance first`);
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
      'no WebAssembly instance is loaded in this tab yet, so there is nothing to point at. Press Diagnose to see why (the game may start on a click, sit in an iframe, or run in a worker)',
    );
  }
  const ids = knownInstances.map((instance) => instance.id).join(', ');
  throw new BridgeError('BAD_PARAMS', `pick an instance first: press Use on a row under Instances (${ids})`);
}

function requireInstance(): string {
  return instanceFrom('scan-instance');
}

/** What each type is for, in the scan form where the choice is made; the value stays the wire name. */
const TYPE_LABELS: Record<string, string> = {
  i8: 'i8 · small whole number',
  u8: 'u8 · byte, 0 to 255',
  i16: 'i16 · whole number',
  u16: 'u16 · whole number, 0 up',
  i32: 'i32 · whole number (most values)',
  u32: 'u32 · whole number, 0 up',
  i64: 'i64 · big whole number (coins)',
  u64: 'u64 · big whole number, 0 up',
  f32: 'f32 · decimal (bars, speed)',
  f64: 'f64 · precise decimal (money)',
};

const MODE_LABELS: Record<string, string> = {
  exact: 'Exact value',
  'not-equal': 'Not this value',
  less: 'Less than',
  greater: 'Greater than',
  'less-or-equal': 'At most',
  'greater-or-equal': 'At least',
  between: 'Between',
  changed: 'Changed',
  unchanged: 'Stayed the same',
  increased: 'Went up',
  decreased: 'Went down',
  'increased-by': 'Went up by',
  'decreased-by': 'Went down by',
};

function fillSelect(select: HTMLSelectElement, values: readonly string[], selected?: string, labels?: Record<string, string>): void {
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labels?.[value] ?? value;
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

/** `1 match`, `3 matches`: counts in the panel are sentences, not `match(es)`. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** f32 carries about seven digits; printing the double it widens to (1.100000023841858) is noise. */
function formatValue(value: number | undefined, type: ValueType): string {
  if (value === undefined) return '';
  if (Number.isNaN(value)) return 'unreadable';
  return type === 'f32' ? String(Number(value.toPrecision(7))) : String(value);
}

/** Lists that came back empty are asked once a second instead of four times: nothing there ticks. */
const emptyLists = new Set<string>();

function markEmpty(name: string, rows: number): void {
  if (rows === 0) emptyLists.add(name);
  else emptyLists.delete(name);
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function span(text: string, className?: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function addressLink(text: string, value?: string, type?: ValueType): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = text;
  button.title = 'Change this address';
  // A live row keeps its current value on the <li>, so the editor opens with what memory holds now.
  button.addEventListener('click', () => selectAddress(text, button.closest('li')?.dataset.value ?? value, type));
  return button;
}

/**
 * Clicking an address is "I want to change this one", so the editor opens beside the hits with the
 * value already in it. The other forms and the memory viewer follow, for whoever goes further.
 */
let pickType: ValueType = 'i32';

function selectAddress(text: string, value?: string, type?: ValueType): void {
  fillAddress(text);
  // A hit has the type it was scanned as; a freeze or watch row brings its own.
  pickType = type ?? typeOf('scan-type');
  for (const id of TYPE_FIELDS) selectOf(id).value = pickType;
  el('pick-address').textContent = text;
  el('pick-type').textContent = pickType;
  const input = el<HTMLInputElement>('pick-value');
  input.value = value ?? '';
  el('pick-out').textContent = '';
  // Undo belongs to the address it was written to; picking another one starts over.
  lastWrite = undefined;
  el('pick-undo').hidden = true;
  el('pick-now').textContent = value === undefined ? '' : `now ${value}`;
  el('pick').hidden = false;
  input.focus();
  input.select();
  markStep(3);
  void syncPickFreeze().catch(() => undefined);
  void jumpViewer(text).catch((error: unknown) => {
    const output = document.getElementById('viewer-out');
    if (output) output.textContent = error instanceof Error ? error.message : String(error);
  });
}

function pickAddress(): Address {
  return parseAddressText(el('pick-address').textContent ?? '');
}

function pickedFreeze(entries: FreezeEntry[]): FreezeEntry | undefined {
  const text = el('pick-address').textContent ?? '';
  return entries.find((entry) => formatAddress(entry.address) === text);
}

/** The Freeze button says what it will do: freeze this address, or let it go. */
async function syncPickFreeze(entries?: FreezeEntry[]): Promise<void> {
  const list = entries ?? (await pageCall<FreezeEntry[]>('page.freeze.list'));
  el('pick-freeze').textContent = pickedFreeze(list) ? 'Unfreeze' : 'Freeze';
}

/** The last write from the editor, so one click puts the old value back. */
let lastWrite: { address: Address; type: ValueType; before: number } | undefined;

async function pickWrite(): Promise<string> {
  const result = await pageCall<WriteResult>('page.write', {
    address: pickAddress(),
    type: pickType,
    value: fieldNum('pick-value', 'new value'),
  });
  lastWrite = { address: result.address, type: result.type, before: result.before };
  el('pick-undo').hidden = false;
  return `${formatAddress(result.address)} ${result.type}: ${result.before} -> ${result.after}`;
}

async function pickUndo(): Promise<string> {
  if (!lastWrite) throw new BridgeError('BAD_PARAMS', 'nothing to undo yet');
  const undo = lastWrite;
  const result = await pageCall<WriteResult>('page.write', { address: undo.address, type: undo.type, value: undo.before });
  lastWrite = undefined;
  el('pick-undo').hidden = true;
  return `undone: ${formatAddress(result.address)} ${result.type}: ${result.before} -> ${result.after}`;
}

async function pickFreeze(): Promise<string> {
  const current = pickedFreeze(await pageCall<FreezeEntry[]>('page.freeze.list'));
  if (current) {
    await pageCall<boolean>('page.freeze.clear', { freezeId: current.id });
  } else {
    await pageCall<FreezeEntry>('page.freeze.set', {
      address: pickAddress(),
      type: pickType,
      value: fieldNum('pick-value', 'new value'),
    });
  }
  const entries = await pageCall<FreezeEntry[]>('page.freeze.list');
  renderFreezes(entries);
  await syncPickFreeze(entries);
  const text = el('pick-address').textContent ?? '';
  return current ? `${text} is free again` : `${text} held at ${el<HTMLInputElement>('pick-value').value.trim()}`;
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

const NO_SCAN_YET = 'No scan yet. Press First Scan with a value you can see on the page; Next Scan then narrows that list.';

function renderList(host: HTMLElement, items: HTMLLIElement[], emptyText: string): void {
  host.replaceChildren(...(items.length ? items : [listItem([span(emptyText, 'empty')])]));
  delete host.dataset.keys;
}

/**
 * A list whose values tick several times a second. Rows are rebuilt only when the set of rows
 * changes; otherwise only the text that moved is rewritten, so a row never jumps, flickers or
 * loses the click that is landing on it.
 */
function liveList<T>(
  host: HTMLElement,
  rows: T[],
  key: (row: T) => string,
  build: (row: T) => HTMLLIElement,
  update: (item: HTMLLIElement, row: T) => void,
  emptyText: string,
  footer = '',
): void {
  if (rows.length === 0) {
    if (host.dataset.keys !== `empty:${emptyText}`) {
      renderList(host, [], emptyText);
      host.dataset.keys = `empty:${emptyText}`;
    }
    return;
  }
  const keys = `${rows.map(key).join('\n')}\n${footer}`;
  if (host.dataset.keys !== keys) {
    const items = rows.map(build);
    if (footer) items.push(listItem([span(footer, 'empty')]));
    host.replaceChildren(...items);
    host.dataset.keys = keys;
  }
  rows.forEach((row, index) => update(host.children[index] as HTMLLIElement, row));
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

  // A reload the panel did on its own is news the human must keep seeing, even after the refresh the
  // reload itself triggers.
  if (startNotice) report(statusOut, startNotice, false);

  const ping = await swCall<PingReply>('ext.ping');
  el('versions').textContent = `extension ${ping.extension} · protocol ${ping.protocol}`;
  // The panel talks to the extension directly; the MCP server only matters to an agent. So "off" is
  // a neutral state, and the token field shows only when a running server refuses this extension.
  if (ping.bridgeRejected) setPill('bridge', 'MCP token refused', 'bad');
  else if (ping.pairingHint) setPill('bridge', 'MCP needs a token', 'warn');
  else if (ping.bridgeConnected) setPill('bridge', 'MCP live', 'live');
  else setPill('bridge', 'MCP off', 'idle');
  el('bridge').title = ping.bridgeConnected
    ? 'An MCP client can drive this tab too.'
    : 'The panel works without it. Start the MCP server to let an agent drive this tab.';
  el('token-box').hidden = !(ping.bridgeRejected || ping.pairingHint);

  const front = await frontTab();
  if (targetTabId === undefined && front) targetTabId = front.tabId;
  if (front && front.tabId === targetTabId) frontTabInfo = front;
  const tabId = targetTabId;
  if (tabId === undefined) {
    el('target').textContent = 'no web page';
    setPill('agent', 'no page', 'idle');
    showNothing(
      'No page to analyze',
      'WasmCheat works on http and https pages. Open DevTools on the page with the game, then choose WasmCheat.',
      false,
    );
    return;
  }
  if (frontTabInfo) {
    el('target').textContent = `${frontTabInfo.title || frontTabInfo.url} · ${frontTabInfo.url}`;
    el('target').classList.remove('process--empty');
  }

  // The first look at a tab goes through ensureAgent, which also catches a game that started before
  // WasmCheat was in the page (and reloads it once); after that a hello is enough.
  let info: PageAgentInfo | undefined;
  if (!startedIn.has(tabId)) {
    info = await startAgent(tabId, statusOut);
  } else {
    info = await swCall<PageAgentInfo>('ext.call', { tabId, method: 'page.hello', params: {} }).catch(() => undefined);
  }
  if (!info) {
    showNothing('WasmCheat cannot run in this page', 'Some pages (the Chrome Web Store, browser settings) do not let extensions in.', true);
    return;
  }
  // Always asked, not only when empty: after a reload the old list describes a page that is gone.
  await refreshInstances().catch(() => undefined);
  const wasm = knownInstances.length === 0 ? 'no wasm' : count(knownInstances.length, 'wasm module');
  setPill(
    'agent',
    info.evalAllowed !== false || knownInstances.length === 0 ? wasm : `${wasm} · scripts blocked`,
    knownInstances.length > 0 && info.evalAllowed !== false ? 'live' : 'idle',
  );
  if (knownInstances.length === 0) {
    showNothing(
      'Nothing to analyze in this tab',
      'This page has not loaded any WebAssembly. WasmCheat works on pages that run it, such as browser games built with Unity, Godot or Emscripten.',
      true,
    );
    return;
  }
  showWorkbench();
  markStep(activeScanId === undefined ? 1 : 2);
  void renderMods().catch(() => undefined);
  // A JavaScript game whose only wasm is its physics engine: say so before the human scans for a
  // score that is not in this memory. Asked after the workbench is up, so it never delays it.
  void pageCall<PageDiagnostics>('page.diagnose')
    .then((diagnostics) => {
      const note = el('physics-note');
      note.hidden = !diagnostics.physicsEngine;
      note.textContent = diagnostics.physicsEngine
        ? `This page's WebAssembly is ${diagnostics.physicsEngine}, a physics engine. Its memory holds bodies, forces and collisions. The score, coins and rules of this game live in JavaScript, so a scan for them finds nothing.`
        : '';
    })
    .catch(() => undefined);
}

let watchForWasm: number | undefined;

/**
 * The page has nothing to work on, so the forms would only invite errors: say so, offer the two
 * things that can change it, and keep looking, because a game that starts on a click instantiates
 * its wasm later and there is no event for that.
 */
function showNothing(title: string, text: string, canRetry: boolean): void {
  el('nothing-title').textContent = title;
  el('nothing-text').textContent = text;
  el('nothing-hint').hidden = !canRetry;
  el('nothing-actions').hidden = !canRetry;
  el('nothing').hidden = false;
  el('workbench').hidden = true;
  // Every tool needs a wasm instance, so the tray would only offer errors; Why is it empty? diagnoses.
  el('advanced').hidden = true;
  if (canRetry && watchForWasm === undefined) {
    watchForWasm = window.setInterval(() => {
      void instanceList()
        .then((instances) => {
          if (instances.length > 0) void refreshStatus().catch(reportStatusError);
        })
        .catch(() => undefined);
    }, 1000);
  }
}

function showWorkbench(): void {
  if (watchForWasm !== undefined) window.clearInterval(watchForWasm);
  watchForWasm = undefined;
  el('nothing').hidden = true;
  el('workbench').hidden = false;
  el('advanced').hidden = false;
}

/** Tabs the panel already tried to start the agent in, so a page that refuses is not reloaded in a loop. */
const startedIn = new Set<number>();
let startNotice = '';

/**
 * Opening the panel on a tab is the whole setup, and turns WasmCheat on for its site. The agent is
 * then in every load of the site from document_start. When it is not (the first time, or a page open
 * before WasmCheat loaded), start it here, which reloads the page once so the game instantiates with
 * the agent present.
 */
async function startAgent(tabId: number, statusOut: HTMLElement): Promise<PageAgentInfo | undefined> {
  startedIn.add(tabId);
  setPill('agent', 'starting…', 'idle');
  try {
    const agent = await swCall<PageAgentInfo>('ext.ensureAgent', { tabId });
    if (agent.autoReloaded) {
      startNotice = 'WasmCheat was not in this page yet, so the page was reloaded once to let it in.';
      report(statusOut, startNotice, false);
    }
    return agent;
  } catch (error) {
    setPill('agent', 'not in this page', 'warn');
    report(statusOut, describeError(error), true);
    return undefined;
  }
}

/**
 * Reload the page with the agent already in it, for a game that instantiated before WasmCheat
 * arrived, then say what came of it. When there is still no wasm, Diagnose is quoted instead of
 * making the human press another button.
 */
function attachAndReport(reload: boolean): () => Promise<string> {
  return async () => {
    const tabId = requireTab();
    const agent = await swCall<PageAgentInfo>('ext.ensureAgent', { tabId, reload });
    await refreshStatus();
    await refreshInstances();
    const lines = [
      knownInstances.length === 0
        ? 'Reloaded. Still no WebAssembly in this page.'
        : `Reloaded. Found ${count(knownInstances.length, 'wasm module')}: ${knownInstances.map((instance) => instance.id).join(', ')}.`,
    ];
    if (agent.evalAllowed === false) lines.push('This page blocks scripts, so hooks need a declarative fallback.');
    if (knownInstances.length === 0) {
      lines.push('', await diagnose().catch((error: unknown) => String(error)));
      lines.push('', 'If the game only starts on a click, start it first, then press Reload page.');
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
      cell(instance.moduleHash ?? '-'),
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

  el('instance-options').replaceChildren(
    ...instances.map((instance) => {
      const option = document.createElement('option');
      option.value = instance.id;
      option.label = `${instance.host === 'worker' ? 'worker' : 'page'} · ${megabytes(instance.memory?.byteLength)}`;
      return option;
    }),
  );
  // Pick one so the human can scan straight away. The game is the module with the most memory (a
  // threaded build lists the same shared memory once per thread; the page's copy wins the tie).
  const current = instances.find((instance) => instance.id === selectedInstanceId);
  const best = [...instances].sort(
    (a, b) => (b.memory?.byteLength ?? 0) - (a.memory?.byteLength ?? 0) || Number(a.host === 'worker') - Number(b.host === 'worker'),
  )[0];
  if (!current && best) selectInstance(best.id);
}

function megabytes(bytes: number | undefined): string {
  if (!bytes) return 'no memory';
  return bytes < 2 ** 20 ? `${Math.round(bytes / 1024)} KiB` : `${Math.round(bytes / 2 ** 20)} MiB`;
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
    ? `${count(instances.length, 'instance')}: ${instances.map((instance) => instance.id).join(', ')}`
    : 'No instances yet. Press Refresh; if it stays empty, press Diagnose to see why.';
}

async function diagnose(): Promise<string> {
  const info = await pageCall<PageDiagnostics>('page.diagnose');
  // The hint goes first: it is the one line that tells a human what to do next.
  return [
    info.hint,
    `url: ${info.url}${info.frameId === undefined ? '' : ` (frame ${info.frameId})`}`,
    `readyState: ${info.readyState} · agent ${info.version} · ${info.agentAgeMs} ms old · eval ${
      info.evalAllowed === undefined ? 'not tried yet' : info.evalAllowed ? 'allowed' : 'blocked'
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
  return `${formatAddress(result.address)} ${count(result.values.length, 'byte')}\nhex ${result.hex ?? ''}`;
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
    const parsed = addressAt(el('viewer-address'));
    viewer = { instanceId: parsed.instanceId, offset: parsed.offset };
  } else {
    viewer = {
      instanceId: viewer.instanceId,
      offset: Math.max(0, viewer.offset + direction * rows * VIEWER_BYTES_PER_ROW),
    };
    el<HTMLInputElement>('viewer-address').value = formatAddress(viewer);
  }
  return dumpMemory(viewer, rows);
}

async function dumpMemory(start: { instanceId: string; offset: number }, rows: number): Promise<string> {
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
  const from = viewer ?? addressAt(el('viewer-address'));
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
        `${worker.id}  ${worker.type.padEnd(6)}  ${count(worker.instances, 'instance')}  ${worker.url || '(no url)'}`,
    )
    .join('\n');
}

async function scanPointers(): Promise<string> {
  const target = addressAt(el('ptr-address'));
  const maxDepth = Math.min(6, Math.max(1, fieldNum('ptr-depth', 'depth')));
  const maxOffset = Math.max(4, fieldNum('ptr-max-offset', 'max offset'));
  const paths = await pageCall<PointerPath[]>('page.pointer.scan', {
    instanceId: target.instanceId,
    offset: target.offset,
    maxDepth,
    maxOffset,
  });
  if (paths.length === 0) {
    return `no chain reaches ${formatAddress(target)} within ${count(maxDepth, 'hop')} and ${maxOffset} bytes per hop - raise either bound`;
  }
  const header = `${count(paths.length, 'chain')}, shortest first`;
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
  const base = parseAddressText(withInstance(addressText));
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
  markEmpty('freezes', entries.length);
  liveList(
    el('freezes'),
    entries,
    (entry) => `${entry.id} ${formatAddress(entry.address)} ${entry.type}=${entry.value}`,
    (entry) =>
      listItem([
        entry.id,
        addressLink(formatAddress(entry.address), String(entry.value), entry.type),
        `${entry.type}=${formatValue(entry.value, entry.type)}`,
        miniButton('Clear', () => {
          void run(el('freeze-out'), async () => {
            await pageCall<boolean>('page.freeze.clear', { freezeId: entry.id });
            renderFreezes(await pageCall<FreezeEntry[]>('page.freeze.list'));
            return `${entry.id} cleared`;
          });
        }),
      ]),
    () => undefined,
    'Nothing frozen. Click an address in Found, then press Freeze.',
  );
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

// ---------------------------------------------------------------- watch

function renderWatches(entries: WatchEntry[]): void {
  markEmpty('watches', entries.length);
  liveList(
    el('watches'),
    entries,
    (entry) => `${entry.id} ${formatAddress(entry.address)} ${entry.type}`,
    (entry) =>
      listItem([
        entry.id,
        addressLink(formatAddress(entry.address), undefined, entry.type),
        span(''),
        miniButton('Remove', () => {
          void run(el('watch-out'), async () => {
            await pageCall<boolean>('page.watch.remove', { watchId: entry.id });
            renderWatches(await pageCall<WatchEntry[]>('page.watch.list'));
            return `${entry.id} removed`;
          });
        }),
      ]),
    (item, entry) => {
      const value = formatValue(entry.lastValue, entry.type);
      item.dataset.value = value;
      setText(item.children[2]!, `${entry.type} now ${value}`);
    },
    'No watches. Enter an address and a type, then press Add.',
  );
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
  renderList(el('watch-events'), items, 'No changes recorded yet. Press Show changes again after the game has run for a moment.');
}

async function watchAdd(): Promise<string> {
  const entry = await pageCall<WatchEntry>('page.watch.add', {
    address: addressAt(el('watch-address')),
    type: typeOf('watch-type'),
  });
  renderWatches(await pageCall<WatchEntry[]>('page.watch.list'));
  return `watching ${entry.id} · ${formatAddress(entry.address)} ${entry.type} (start ${entry.lastValue})`;
}

async function watchPoll(): Promise<string> {
  const events = await pageCall<WatchEvent[]>('page.watch.poll', {});
  renderWatchEvents(events);
  return events.length ? `${count(events.length, 'event')}, newest first` : 'no changes since you last looked';
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
  el('scan-quick').hidden = step === 'first';
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
  el<HTMLInputElement>('scan-value').placeholder = optional ? 'optional' : '75, or empty';
  if (valueField) valueField.classList.toggle('field--optional', optional);
}

/** How many hits the Found list shows and keeps live; past that, narrowing is the useful move. */
const FOUND_LIMIT = 100;
/** The type the open scan was made with: a hit is that type even if the form has changed since. */
let scanType: ValueType = 'i32';

function renderScanSummary(summary: ScanSummary): void {
  activeScanId = summary.scanId;
  scanType = summary.type;
  markScanStep('narrow');
  markStep(2);
  el('scan-id').textContent = `scan ${summary.scanId} · ${count(summary.matchCount, 'match', 'matches')}`;
  renderScanHits(summary.sample, summary.matchCount);
}

/**
 * The Found list, kept live: Value is memory now, Previous is the value at the last scan, and a
 * value that moved since is marked, which is what tells you whether Next Scan should say changed.
 */
function renderScanHits(hits: ScanHit[], total: number): void {
  const sorted = [...hits].sort((a, b) => a.address.offset - b.address.offset);
  const hidden = total - sorted.length;
  liveList(
    el('scan-hits'),
    sorted,
    (hit) => formatAddress(hit.address),
    (hit) => listItem([addressLink(formatAddress(hit.address), undefined, scanType), span(''), span('', 'hit__previous')]),
    (item, hit) => {
      const value = formatValue(hit.value, scanType);
      item.dataset.value = value;
      const [, valueCell, previousCell] = item.children;
      setText(valueCell!, value);
      setText(previousCell!, formatValue(hit.previous, scanType));
      const moved = hit.previous !== undefined && !Object.is(hit.value, hit.previous);
      valueCell!.classList.toggle('hit--moved', moved);
    },
    total === 0
      ? 'No address holds that value. Check the type (coins are often i64 or f64), or start again with First Scan.'
      : `Every address is still a candidate (${count(total, 'position')}). Change the value in the game, then press Went up, Went down, Changed or Stayed the same.`,
    hidden > 0 ? `${count(hidden, 'more address', 'more addresses')} not shown. Narrow with Next Scan.` : '',
  );
}

/** One live read of the Found list. Errors stay quiet here: the buttons report them. */
async function liveFound(): Promise<void> {
  const scanId = activeScanId;
  if (!scanId) return;
  try {
    const result = await pageCall<{ hits: ScanHit[]; total: number }>('page.scan.results', { scanId, limit: FOUND_LIMIT });
    if (activeScanId === scanId) renderScanHits(result.hits, result.total);
  } catch (error) {
    if (asBridgeError(error).code === 'SCAN_CLOSED' && activeScanId === scanId) scanGone();
  }
}

/** A reload starts the page from scratch, scans included; say so instead of showing dead hits. */
function scanGone(): void {
  activeScanId = undefined;
  el('scan-id').textContent = 'no scan';
  markScanStep('first');
  markStep(1);
  renderList(
    el('scan-hits'),
    [],
    'The page reloaded, so that scan is gone. Run First Scan again (Saved scans under More tools keep one across reloads).',
  );
}

function requireScanId(): string {
  if (!activeScanId) throw new BridgeError('SCAN_CLOSED', 'no scan open: press First Scan first');
  return activeScanId;
}

function scanSummaryLine(summary: ScanSummary, verb: string): string {
  return `${verb} ${summary.scanId} · ${summary.mode} ${summary.type} · ${count(summary.matchCount, 'match', 'matches')}${
    summary.truncated ? ' · truncated at maxResults' : ''
  } · memory ${summary.memoryByteLength} B`;
}

/** Delta modes compare with the previous pass; with no value they start an unknown-value scan. */
const DELTA_SCAN_MODES: readonly string[] = ['changed', 'unchanged', 'increased', 'decreased', 'increased-by', 'decreased-by'];

async function scanBegin(): Promise<string> {
  const picked = selectOf('scan-mode').value as ScanMode;
  // An empty value means "I cannot read it" (a health bar): start from every address and narrow by
  // how it moves, instead of refusing because exact needs a number.
  const unknown = !el<HTMLInputElement>('scan-value').value.trim() && !DELTA_SCAN_MODES.includes(picked);
  const mode: ScanMode = unknown ? 'unchanged' : picked;
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
  await liveFound();
  if (unknown || (summary.sample.length === 0 && summary.matchCount > 0)) {
    return `began ${summary.scanId} · unknown value ${summary.type} · every address is a candidate (${count(summary.matchCount, 'position')}). Change it in the game, then press Went up, Went down, Changed or Stayed the same.`;
  }
  return scanSummaryLine(summary, 'began');
}

async function scanNarrow(): Promise<string> {
  const summary = await pageCall<ScanSummary>('page.scan.next', {
    scanId: requireScanId(),
    ...scanCompareParams(selectOf('scan-mode').value as ScanMode),
  });
  renderScanSummary(summary);
  await liveFound();
  return scanSummaryLine(summary, 'narrowed');
}

/** One click per movement: the same narrowing as picking the mode and pressing Next Scan. */
async function scanMoved(mode: ScanMode): Promise<string> {
  const summary = await pageCall<ScanSummary>('page.scan.next', { scanId: requireScanId(), mode });
  renderScanSummary(summary);
  await liveFound();
  return scanSummaryLine(summary, 'narrowed');
}

async function scanDrop(): Promise<string> {
  const id = requireScanId();
  const dropped = await pageCall<boolean>('page.scan.drop', { scanId: id });
  activeScanId = undefined;
  el('scan-id').textContent = 'no scan';
  markScanStep('first');
  markStep(1);
  renderList(el('scan-hits'), [], NO_SCAN_YET);
  return dropped ? `${id} dropped` : `${id} was already closed`;
}

async function bookmarkAdd(): Promise<string> {
  const label = el<HTMLInputElement>('bookmark-label').value.trim();
  const address = el<HTMLInputElement>('bookmark-address').value.trim();
  const bookmark = await pageCall<Bookmark>('page.bookmark.add', { label, address: withInstance(address), type: typeOf('bookmark-type') });
  await bookmarkList();
  return `bookmarked "${bookmark.label}" -> ${bookmark.address}`;
}

/** Reads every bookmark that names its type, so the list shows what each address holds now. */
async function bookmarkValues(items: Bookmark[]): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  await Promise.all(
    items.map(async (bookmark) => {
      if (!bookmark.type) return;
      try {
        const read = await pageCall<ReadResult>('page.read', { address: parseAddressText(bookmark.address), type: bookmark.type });
        values.set(bookmark.id, formatValue(read.values[0] as number, bookmark.type));
      } catch {
        values.set(bookmark.id, 'not readable');
      }
    }),
  );
  return values;
}

function renderBookmarks(items: Bookmark[], values: Map<string, string>): void {
  markEmpty('bookmarks', items.length);
  liveList(
    el('bookmark-list-out'),
    items,
    (bookmark) => `${bookmark.id} ${bookmark.label} ${bookmark.address} ${bookmark.type ?? ''}`,
    (bookmark) =>
      listItem([
        span(bookmark.label),
        addressLink(bookmark.address, undefined, bookmark.type),
        span(''),
        miniButton('Forget', () => {
          void pageCall<boolean>('page.bookmark.remove', { id: bookmark.id }).then(bookmarkList);
        }),
      ]),
    (item, bookmark) => {
      const value = values.get(bookmark.id);
      if (value !== undefined) item.dataset.value = value;
      setText(item.children[2]!, bookmark.type ? `${bookmark.type} now ${value ?? ''}` : '');
    },
    'No bookmarks. Type an address and a label, then press Add bookmark.',
  );
}

async function bookmarkList(): Promise<string> {
  const items = await pageCall<Bookmark[]>('page.bookmark.list');
  renderBookmarks(items, await bookmarkValues(items));
  return items.length === 0 ? 'nothing bookmarked yet' : count(items.length, 'bookmark');
}

async function bookmarkClear(): Promise<string> {
  const { removed } = await pageCall<{ removed: number }>('page.bookmark.clear');
  await bookmarkList();
  return `cleared ${count(removed, 'bookmark')}`;
}

async function savedList(): Promise<string> {
  const items = await pageCall<SavedScanSummary[]>('page.saved.list');
  renderList(
    el('saved-list-out'),
    items.map((item) => listItem([span(`${item.name} · ${count(item.matchCount, 'match', 'matches')} · ${item.mode} ${item.type}`)])),
    'No saved scans in this page. Save one before anything reloads it.',
  );
  return items.length === 0 ? 'nothing saved yet' : count(items.length, 'saved scan');
}

async function savedSave(): Promise<string> {
  const name = requireSavedName();
  const saved = await pageCall<SavedScanSummary>('page.saved.save', { name, scanId: requireScanId() });
  await savedList();
  return `saved "${saved.name}" · ${count(saved.matchCount, 'match', 'matches')}`;
}

async function savedOpen(): Promise<string> {
  const name = requireSavedName();
  const opened = await pageCall<{ scanId: string; summary: ScanSummary }>('page.saved.open', { name });
  activeScanId = opened.scanId;
  scanType = opened.summary.type;
  markScanStep('narrow');
  markStep(2);
  el('scan-id').textContent = `scan ${opened.scanId} · ${count(opened.summary.matchCount, 'match', 'matches')} (from "${name}")`;
  await liveFound();
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
  return `${result.matches.length} of ${count(result.total, 'match', 'matches')} · ${result.encoding}${
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
    `address: ${status.address ?? '-'} · type: ${status.type ?? '-'} · kind: ${status.kind ?? '-'} · instance: ${
      status.instanceId ?? '-'
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
      listItem([entry.name ?? `wasm-function[${entry.funcIndex}]`, count(entry.hits, 'hit')]),
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
  renderList(el('patches'), items, 'No patches. Choose a target and a mode, then press Add.');
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
  return `${entry.id} ${entry.mode} ${entry.target}: reload to install it`;
}

async function patchList(): Promise<string> {
  const entries = await pageCall<PatchEntry[]>('page.patch.list');
  renderPatches(entries);
  return count(entries.length, 'patch', 'patches');
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
      count(entry.calls, 'call'),
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
  return count(entries.length, 'hook');
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
  el('audit-note').textContent = `${reply.note}. Showing ${reply.lines.length} of ${reply.total}`;
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
      setPill('bridge', 'MCP token refused', 'bad');
      report(el('status-out'), data?.hint ?? 'the bridge refused this extension: paste the bridge token');
    }
    // A relay announcing itself in the target tab means its page loaded again; other tabs are not ours.
    const changed = payload.data as { tabId?: number } | null;
    if (payload.event === 'tabs.changed' && (targetTabId === undefined || changed?.tabId === targetTabId)) {
      scheduleStatusRefresh();
    }
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError keeps Chrome from reporting an unchecked runtime error for a closed port.
    void chrome.runtime.lastError;
    logEvent('panel.portclosed', { note: 'service worker went away; reconnecting' });
    window.setTimeout(openEvents, 1000);
  });
}

// ---------------------------------------------------------------- live values

/**
 * Four reads a second keep everything on screen current: the Found list, the picked address, the
 * freezes, watches and bookmarks, and the memory view when it is open. Each list is one call and
 * all of them run together, so a tick costs a few milliseconds; it never overlaps the next one,
 * and it stops while the panel is out of sight.
 */
const LIVE_MS = 250;
/** Every fourth tick also checks whether the page gained or lost a wasm module. */
const INSTANCE_EVERY = 4;
let panelShown = true;
let liveTicks = 0;

function liveActive(): boolean {
  return panelShown && document.visibilityState === 'visible' && !el('workbench').hidden && targetTabId !== undefined;
}

async function livePick(): Promise<void> {
  if (el('pick').hidden) return;
  const text = el('pick-address').textContent ?? '';
  const type = pickType;
  let now: string;
  try {
    const read = await pageCall<ReadResult>('page.read', { address: parseAddressText(text), type });
    now = `now ${formatValue(read.values[0] as number, type)}`;
  } catch {
    now = 'not readable now';
  }
  if (el('pick-address').textContent === text) setText(el('pick-now'), now);
}

async function liveFreezes(): Promise<void> {
  const entries = await pageCall<FreezeEntry[]>('page.freeze.list');
  renderFreezes(entries);
  if (!el('pick').hidden) await syncPickFreeze(entries);
}

async function liveWatches(): Promise<void> {
  renderWatches(await pageCall<WatchEntry[]>('page.watch.list'));
}

async function liveBookmarks(): Promise<void> {
  const items = await pageCall<Bookmark[]>('page.bookmark.list');
  renderBookmarks(items, await bookmarkValues(items));
}

async function liveViewer(): Promise<void> {
  if (!viewer || !el<HTMLDetailsElement>('advanced').open) return;
  const rows = Math.min(64, Math.max(1, Number(el<HTMLInputElement>('viewer-rows').value) || 16));
  const start = viewer;
  const text = await dumpMemory(start, rows);
  if (viewer === start) setText(el('viewer-out'), text);
}

/** A module that appears or goes away changes what there is to scan, so the header follows it. */
async function liveInstances(): Promise<void> {
  const instances = await instanceList();
  const ids = instances.map((instance) => instance.id).join(',');
  if (ids === knownInstances.map((instance) => instance.id).join(',')) return;
  renderInstances(instances);
  await refreshStatus();
}

async function liveTick(): Promise<void> {
  liveTicks += 1;
  const slow = liveTicks % INSTANCE_EVERY === 0;
  const due = (name: string): boolean => slow || !emptyLists.has(name);
  const jobs = [liveFound(), livePick(), liveViewer()];
  if (due('freezes')) jobs.push(liveFreezes());
  if (due('watches')) jobs.push(liveWatches());
  if (due('bookmarks')) jobs.push(liveBookmarks());
  if (slow) jobs.push(liveInstances());
  await Promise.allSettled(jobs);
}

function startLive(): void {
  const loop = async (): Promise<void> => {
    if (liveActive()) await liveTick();
    window.setTimeout(() => void loop(), LIVE_MS);
  };
  void loop();
  // DevTools keeps a hidden panel's document alive and "visible"; devtools.ts tells us instead.
  window.addEventListener('wasmcheat:shown', () => {
    panelShown = true;
  });
  window.addEventListener('wasmcheat:hidden', () => {
    panelShown = false;
  });
}

// ---------------------------------------------------------------- testability hooks

/**
 * Small surface for the e2e suite. It calls the same functions the buttons call, so a passing test
 * exercises the real path rather than a test-only shortcut.
 */
function scriptCode(): string {
  const code = el<HTMLTextAreaElement>('script-code').value;
  if (!code.trim()) throw new BridgeError('BAD_PARAMS', 'type some code to run');
  return code;
}

function describeScriptResult(result: ScriptResult): string {
  const shown = typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2);
  return `${shown}\n(${result.type}, ${result.ms} ms${result.truncated ? ', cut at 64 KB' : ''})`;
}

async function runScript(): Promise<string> {
  return describeScriptResult(await pageCall<ScriptResult>('page.script.run', { code: scriptCode() }));
}

async function addMod(): Promise<string> {
  const tabId = targetTabId;
  if (tabId === undefined) throw new BridgeError('NO_TAB', 'no tab to keep a mod for');
  const name = el<HTMLInputElement>('mod-name').value.trim() || 'mod';
  const added = await swCall<{ mod: ModEntry; result: ScriptResult }>('ext.mods.add', { tabId, name, code: scriptCode() });
  await renderMods();
  return `${describeScriptResult(added.result)}\nKept as "${added.mod.name}": it runs on every load of ${added.mod.origin}.`;
}

async function renderMods(): Promise<void> {
  const tabId = targetTabId;
  const mods = tabId === undefined ? [] : await swCall<ModEntry[]>('ext.mods.list', { tabId });
  const items = mods.map((mod) =>
    listItem([
      mod.name,
      new URL(mod.origin).host,
      miniButton('Remove', () => {
        void run(el('script-out'), async () => {
          await swCall<ModEntry[]>('ext.mods.remove', { modId: mod.id });
          await renderMods();
          return `"${mod.name}" removed: it no longer runs from the next load on.`;
        });
      }),
    ]),
  );
  renderList(el('mods'), items, 'Nothing kept for this game. Write a script above and press Run and keep.');
}

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
  fillSelect(selectOf('bookmark-type'), VALUE_TYPES, 'i32');
  fillSelect(selectOf('scan-type'), VALUE_TYPES, 'i32', TYPE_LABELS);
  fillSelect(selectOf('scan-mode'), SCAN_MODES, 'exact', MODE_LABELS);
  fillSelect(selectOf('trace-kind'), TRACE_KINDS, 'write');
  fillSelect(selectOf('patch-mode'), PATCH_MODES, 'stub');

  const statusOut = el('status-out');
  bind('refresh-status', statusOut, async () => {
    await refreshStatus();
    return '';
  });
  bind('attach-reload', statusOut, attachAndReport(true));
  bind('nothing-reload', el('nothing-out'), attachAndReport(true));
  bind('nothing-diagnose', el('nothing-out'), diagnose);
  bind('token-save', statusOut, async () => {
    const token = el<HTMLInputElement>('bridge-token').value.trim();
    if (!token) throw new BridgeError('BAD_PARAMS', 'paste the contents of ~/.wasmcheat/token first');
    // Saving is what fixes a refused bridge: the service worker watches this key and reconnects.
    await chrome.storage.local.set({ bridgeToken: token, bridgeTokenSource: 'pasted' });
    await refreshStatus();
    return 'token saved; reconnecting to the bridge';
  });

  bind('instances-refresh', el('instances-out'), refreshInstances);
  bind('pick-write', el('pick-out'), pickWrite);
  bind('pick-freeze', el('pick-out'), pickFreeze);
  bind('pick-undo', el('pick-out'), pickUndo);
  el<HTMLInputElement>('pick-value').addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') el<HTMLButtonElement>('pick-write').click();
  });

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

  bind('script-run', el('script-out'), runScript);
  bind('mod-add', el('script-out'), addMod);
  el<HTMLTextAreaElement>('script-code').addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (key.key === 'Enter' && (key.metaKey || key.ctrlKey)) {
      key.preventDefault();
      el<HTMLButtonElement>('script-run').click();
    }
  });

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

  bind('watch-add', el('watch-out'), watchAdd);
  bind('watch-poll', el('watch-out'), watchPoll);

  bind('scan-begin', el('scan-out'), scanBegin);
  bind('scan-narrow', el('scan-out'), scanNarrow);
  bind('scan-drop', el('scan-out'), scanDrop);
  for (const button of el('scan-quick').querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    button.addEventListener('click', () => void run(el('scan-out'), () => scanMoved(button.dataset.mode as ScanMode)));
  }
  bind('text-scan', el('text-out'), scanText);
  bind('saved-save', el('saved-out'), savedSave);
  bind('saved-list', el('saved-out'), savedList);
  bind('saved-open', el('saved-out'), savedOpen);
  bind('saved-delete', el('saved-out'), savedDelete);
  bind('bookmark-add', el('bookmark-out'), bookmarkAdd);
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

  renderList(el('scan-hits'), [], NO_SCAN_YET);
  renderList(el('event-log'), [], 'No events yet. Bridge and page events appear here as they happen.');
  openEvents();
  startLive();

  (window as unknown as { __panel: PanelTestHooks }).__panel = {
    attach: panelAttach,
    call: (method, params) => dispatch(method, params ?? {}),
  };

  installPanelHelp();

  void refreshStatus().catch(reportStatusError);
}

wire();
