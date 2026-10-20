/**
 * The wire contract shared by the page agent, the extension service worker and the
 * MCP server. Everything here must stay JSON-serialisable: it crosses a WebSocket,
 * a `window.postMessage` boundary and the MCP stdio pipe.
 */

export const PROTOCOL_VERSION = 1;

/**
 * The one control message the extension sends as a *request*: it asks the bridge for the token it
 * has to present. Pairing exists because the token lives in a file the browser cannot read, and
 * typing `~/.wasmcheat/token` into a password box is the step where a normal person gives up.
 */
export const BRIDGE_PAIR = 'bridge.pair';

/** Value types a scan, read or write can use. Matches wasm's numeric types. */
export const VALUE_TYPES = [
  'i8',
  'u8',
  'i16',
  'u16',
  'i32',
  'u32',
  'i64',
  'u64',
  'f32',
  'f64',
] as const;

export type ValueType = (typeof VALUE_TYPES)[number];

export const VALUE_TYPE_BYTES: Record<ValueType, number> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  i64: 8,
  u64: 8,
  f32: 4,
  f64: 8,
};

/** An address inside one instance's linear memory. */
export interface Address {
  instanceId: string;
  /** Byte offset from the start of the instance's memory. */
  offset: number;
}

/** Renders an address the way tool results show it, e.g. `w1:0x1f40`. */
export function formatAddress(address: Address): string {
  return `${address.instanceId}:0x${address.offset.toString(16)}`;
}

/** Parses `w1:0x1f40` or `w1:7984`. Throws on malformed input. */
export function parseAddress(text: string): Address {
  const match = /^([A-Za-z0-9_-]+):(0x[0-9a-fA-F]+|\d+)$/.exec(text.trim());
  if (!match) throw new Error(`Invalid address "${text}", expected <instanceId>:<offset>`);
  const [, instanceId, raw] = match as unknown as [string, string, string];
  const offset = raw.startsWith('0x') ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid address offset "${raw}"`);
  return { instanceId, offset };
}

export interface MemoryInfo {
  /** Byte length right now. Re-read after growth; buffers detach on grow. */
  byteLength: number;
  /** Page allocator's current break, when the instance looks like emscripten/wasm-bindgen. */
  maxByteLength: number | null;
  growable: boolean;
}

export interface ExportInfo {
  name: string;
  kind: 'function' | 'memory' | 'table' | 'global';
  /** Present for functions: declared arity, when the engine exposes it. */
  arity: number | null;
}

/** Which JS realm captured an instance: the document itself, or a Worker the document created. */
export type InstanceHost = 'page' | 'worker';

export interface InstanceInfo {
  id: string;
  /** Stable hash of the module bytes, when we could capture them. */
  moduleHash: string | null;
  /** How the instance was created, which drives import-patch capabilities. */
  createdBy: 'instantiate' | 'instantiateStreaming' | 'new Instance';
  /** True when the agent could resolve a WebAssembly.Memory for this instance. */
  memoryResolved: boolean;
  memory: MemoryInfo | null;
  exports: ExportInfo[];
  /** Registered when the instance is created, in page clock ms. */
  createdAt: number;
  /** Whether an import hook can still take effect on this instance. */
  importPatchability: 'live' | 'next-instantiation' | 'none';
  /** Realm that captured it. A game whose engine runs in a Worker reports `worker` here. */
  host?: InstanceHost;
  /** Worker the instance lives in, when `host` is `worker`. */
  workerId?: string;
}

/** A frame inside a tab. Games are often served from a cross-origin subframe. */
export interface FrameRef {
  frameId: number;
  url: string;
}

export interface TabInfo {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  /** True once the page agent has been injected and answered. */
  agentAttached: boolean;
  /** Known frames with a live relay, once the page has announced itself. */
  frames?: FrameRef[];
}

/** Comparison applied by a scan pass. The first pass always snapshots; later passes filter. */
export type ScanMode =
  | 'exact'
  | 'not-equal'
  | 'less'
  | 'greater'
  | 'less-or-equal'
  | 'greater-or-equal'
  | 'between'
  | 'changed'
  | 'unchanged'
  | 'increased'
  | 'decreased'
  | 'increased-by'
  | 'decreased-by';

/**
 * A scan session frozen into something `sessionStorage` can hold: a reload destroys the page's
 * memory of a scan, and a user who has narrowed 40,000 candidates down to six does not want to
 * start over. Addresses and values travel as base64 typed arrays.
 */
export interface SavedScanData {
  instanceId: string;
  type: ValueType;
  mode: ScanMode;
  count: number;
  addresses: string;
  values: string;
  memoryByteLength: number;
  passes: number;
  createdAt: number;
}

/** What `page.saved.list` reports: everything but the arrays. */
export interface SavedScanSummary {
  name: string;
  createdAt: number;
  type: ValueType;
  mode: ScanMode;
  matchCount: number;
  instanceId: string;
  memoryByteLength: number;
}

/**
 * A named address, the way Cheat Engine's address list works: the label is the thing a human (or an
 * agent) remembers, and the offset behind it is what the tool needs.
 */
export interface Bookmark {
  id: string;
  label: string;
  address: string;
  type?: ValueType;
  note?: string;
  createdAt: number;
}

export const SCAN_MODES: ScanMode[] = [
  'exact',
  'not-equal',
  'less',
  'greater',
  'less-or-equal',
  'greater-or-equal',
  'between',
  'changed',
  'unchanged',
  'increased',
  'decreased',
  'increased-by',
  'decreased-by',
];

export type TextEncoding = 'ascii' | 'utf8' | 'bytes';

export interface TextScanOptions {
  instanceId: string;
  /** Text to look for. For encoding `bytes`, a hex string like "deadbeef". */
  text: string;
  encoding?: TextEncoding;
  caseSensitive?: boolean;
  range?: { start: number; end: number };
  maxResults?: number;
}

export interface TextScanResult {
  encoding: TextEncoding;
  /** Offsets of every match, capped at maxResults. */
  matches: number[];
  total: number;
  truncated: boolean;
  memoryByteLength: number;
}

export interface ScanOptions {
  instanceId: string;
  type: ValueType;
  mode: ScanMode;
  /** Target of the comparison; required for every mode except the delta ones. */
  value?: number;
  /** Upper bound for mode `between`. */
  value2?: number;
  /** Absolute tolerance for f32/f64 comparisons. */
  tolerance?: number;
  /** Candidate stride. Defaults to the type width; 1 allows unaligned hits. */
  alignment?: number;
  /** Restrict the first pass to a byte range. */
  range?: { start: number; end: number };
  /** Upper bound on retained candidates; scanning stops keeping more. */
  maxResults?: number;
}

export interface ScanSummary {
  scanId: string;
  mode: ScanMode;
  type: ValueType;
  /** Candidates still alive after this pass. */
  matchCount: number;
  /** True when the candidate list was truncated at maxResults. */
  truncated: boolean;
  /** First few candidates, for the agent to eyeball without a second call. */
  sample: ScanHit[];
  /** Byte length of the scanned memory at the time of the pass. */
  memoryByteLength: number;
}

export interface ScanHit {
  address: Address;
  value: number;
}

export interface ReadResult {
  address: Address;
  type: ValueType;
  values: number[];
  /** Raw bytes as hex, when the caller asked for a byte-level read. */
  hex?: string;
}

export interface WriteResult {
  address: Address;
  type: ValueType;
  before: number;
  after: number;
}

/**
 * Answer to `page.speed.set` / `page.speed.status`. `scale` multiplies the page's perceived time:
 * 1 is real time, 0 stops it, 3 is three times faster.
 */
export interface SpeedStatus {
  scale: number;
  installed: boolean;
}

export interface FreezeEntry {
  id: string;
  address: Address;
  type: ValueType;
  value: number;
  createdAt: number;
}

export interface WatchEntry {
  id: string;
  address: Address;
  type: ValueType;
  lastValue: number;
  createdAt: number;
}

export interface WatchEvent {
  watchId: string;
  address: Address;
  type: ValueType;
  before: number;
  after: number;
  at: number;
}

/** Declarative hook behaviour, used when page CSP forbids evaluating a script body. */
export type HookFallbackMode = 'passthrough' | 'replace-return' | 'offset-result';

export interface HookSpec {
  instanceId: string;
  target: 'export' | 'import';
  /** Export name, or `module.name` for imports. */
  name: string;
  /** JS function body: receives `(args, ctx)` and returns the value to use. */
  body: string;
  /** Used when `body` cannot be evaluated because of the page's CSP. */
  fallback?: { mode: HookFallbackMode; value?: number };
  /** Human-readable note stored in the audit log. */
  note?: string;
}

export interface HookEntry {
  id: string;
  instanceId: string;
  target: 'export' | 'import';
  name: string;
  enabled: boolean;
  body: string;
  fallbackUsed: boolean;
  /** Call count observed since install. */
  calls: number;
  lastArgs: unknown[] | null;
  lastReturn: unknown;
  createdAt: number;
  /** For imports on an already-instantiated module: why it is not live yet. */
  pending: boolean;
}

export interface PageAgentInfo {
  /** True when the extension reloaded the tab itself, because the page predated the agent. */
  autoReloaded?: boolean;
  version: string;
  url: string;
  /** Frame the extension routed this call to; absent on the top frame's own answer. */
  frameId?: number;
  /** True when the page realm allows `new Function`, i.e. free-form hook scripts work. */
  evalAllowed: boolean;
}

export type WorkerType = 'classic' | 'module';

/**
 * A worker the page agent bootstrapped, as reported by `page.listWorkers`.
 *
 * Ids are namespaced by realm so a document and its workers cannot mint the same id: the page
 * agent gives every wrapped Worker an id (`k1`, `k2`, …) and a worker names everything it mints
 * `<workerId>-<local>` — instances `k1-1`, `k1-2`, scans `k1-s1`, freezes `k1-f1`, watches
 * `k1-v1`, hooks `k1-h1`. An id with no `-` belongs to the page realm, so routing is exactly
 * "everything before the first dash".
 *
 * Limits: a Worker created before the agent learned where `worker-agent.js` lives stays
 * un-instrumented, a worker created inside a worker (nested) bypasses this wrapper, and a
 * cross-origin worker URL cannot be constructed at all — none of those are visible here.
 */
export interface WorkerInfo {
  /** Worker id assigned at construction, e.g. `k1`. */
  id: string;
  /** The script URL the page asked for, not the blob bootstrap that actually runs. */
  url: string;
  type: WorkerType;
  /** Instances this worker has captured as of the last probe. */
  instances: number;
}

/** A worker agent's answer to `{__wasmcheat: 'hello'}`; answerable before any instance exists. */
export interface WorkerAgentInfo extends PageAgentInfo {
  instances: number;
}

/** Every message crossing the page <-> worker boundary carries this tag. */
export const WORKER_CHANNEL_KEY = '__wasmcheat';

export interface WorkerCallMessage {
  __wasmcheat: 'call';
  id: string;
  method: string;
  params: unknown;
}

export interface WorkerResultMessage {
  __wasmcheat: 'result';
  id: string;
  result?: unknown;
  error?: BridgeErrorShape;
}

export interface WorkerHelloMessage {
  __wasmcheat: 'hello';
}

export interface WorkerHelloReplyMessage {
  __wasmcheat: 'hello';
  info: WorkerAgentInfo;
}

export type WorkerMessage =
  | WorkerCallMessage
  | WorkerResultMessage
  | WorkerHelloMessage
  | WorkerHelloReplyMessage;

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  const m = value as { __wasmcheat?: unknown } | null;
  return (
    !!m &&
    typeof m === 'object' &&
    (m.__wasmcheat === 'call' || m.__wasmcheat === 'result' || m.__wasmcheat === 'hello')
  );
}

/** `k1-1` -> `k1`. An id without a dash belongs to the page realm, so it has no worker owner. */
export function workerIdOf(id: string): string | null {
  const dash = id.indexOf('-');
  return dash > 0 ? id.slice(0, dash) : null;
}

/** Why a tab shows no instances: the answer is almost always one of these fields. */
/**
 * A read or write watchpoint. WebAssembly exposes no memory-access events, so the only way to
 * learn which function touched an address is to rewrite the module before it compiles: every
 * store gets a guarded call back into the host, and every load gains a guarded identity call
 * that reports its address. Arming therefore only takes effect on the next instantiation, which
 * is why the tools reload the tab.
 */
export interface TraceArmOptions {
  /** Address to watch, e.g. "w1:0x408". The width comes from `type`. */
  address: string;
  /** Width used for the value snapshots. Default i32. */
  type?: ValueType;
  /** Stop recording after this many hits. Default 50. */
  maxHits?: number;
  /** Which access to catch. Default `write`. */
  kind?: TraceKind;
}

export const TRACE_KINDS = ['write', 'read'] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export interface WriteTraceHit {
  /** Milliseconds since the epoch. */
  at: number;
  /** What the function did: stored to the address, or loaded from it. */
  kind: TraceKind;
  /** Index of the wasm function that performed the access, in the module's function space. */
  funcIndex: number;
  /** Export name of that function, when the module exports it. */
  funcName?: string;
  address: string;
  previous: number | string;
  value: number | string;
}

export interface WriteTraceStatus {
  armed: boolean;
  /** True once an instrumented instance exists and the callback is wired. */
  installed: boolean;
  address?: string;
  type?: ValueType;
  kind?: TraceKind;
  instanceId?: string;
  hits: WriteTraceHit[];
  /** Hits dropped after `maxHits`. */
  dropped: number;
  /**
   * Functions that touched the address, most hits first. `instanceId` names the instance whose
   * module the function belongs to, since every instrumented instance is watched in its own memory.
   */
  functions: { funcIndex: number; name?: string; hits: number; instanceId?: string }[];
  /** Why the trace cannot install, when it cannot. */
  note?: string;
}

/**
 * Function patches. A wasm function body can only be replaced before the module is compiled, so a
 * patch is stored, applied to the module as it is instantiated, and reported as pending until the
 * reload that installs it.
 *
 * `stub` replaces the body with a constant return, which is how you switch off a behaviour the
 * module never exposes as an import or export (damage, a timer, an anti-cheat check). Callers keep
 * calling it; it just stops doing anything.
 */
export interface PatchSpec {
  /** Export name of the function, or `wasm-function[12]` for a function the module does not export. */
  target: string;
  /** `stub` returns `value` (default 0); `empty` is for void functions only. */
  mode: PatchMode;
  /** Constant returned by a stub. Ignored by `empty`. */
  value?: number;
  note?: string;
}

export const PATCH_MODES = ['stub', 'empty'] as const;
export type PatchMode = (typeof PATCH_MODES)[number];

export interface PatchEntry extends PatchSpec {
  id: string;
  /** Defined-function index the target resolved to when the module was rewritten. */
  funcIndex?: number;
  /** True once a module was actually instantiated with this patch applied. */
  applied: boolean;
  /** How many instantiations the patch has been applied to. */
  applications: number;
  createdAt: number;
}

/**
 * A pointer path: `read(base) + offsets[0]`, then `read(that) + offsets[1]`, and so on, reaches the
 * target address. In wasm a pointer is a 32-bit offset into linear memory, so the whole scan is an
 * index of the words that look like pointers, walked backwards from the address you care about.
 */
export interface PointerPath {
  base: Address;
  /** Value stored at the base, which is the first hop of the chain. */
  baseValue: number;
  /** Offsets applied in order; the last one lands on the target. */
  offsets: number[];
  depth: number;
  target: Address;
}

export interface PointerScanOptions {
  instanceId: string;
  /** Offset of the address the chain must reach. */
  offset: number;
  /** How many pointer hops to follow, 1..6. Default 3. */
  maxDepth?: number;
  /** Largest byte offset tried at each hop, in multiples of 4. Default 0x400. */
  maxOffset?: number;
  maxResults?: number;
}

export interface PointerHop {
  address: string;
  value: number;
}

export interface PointerResolution {
  hops: PointerHop[];
  /** Address the chain ends at, formatted. */
  final: string;
  /** Value at the final address, or null when the chain leaves memory. */
  value: number | null;
}

export interface PageDiagnostics extends PageAgentInfo {
  title: string;
  readyState: string;
  /** Times the app went through each entry point we patched. All zero = it never tried. */
  calls: { instantiate: number; instantiateStreaming: number; newInstance: number; compile: number };
  /** Milliseconds between the agent being installed and now. */
  agentAgeMs: number;
  instances: number;
  /** Frames in this document. A cross-origin game frame is invisible to the top frame's agent. */
  iframes: { src: string; crossOrigin: boolean; width: number; height: number }[];
  canvases: number;
  /** .wasm URLs visible in the document markup, as a hint about where the code lives. */
  wasmReferences: string[];
  /** One line telling the agent what to do next. */
  hint: string;
}

/** Envelope for every message on the bridge. */
export interface RequestMessage {
  v: typeof PROTOCOL_VERSION;
  kind: 'req';
  id: string;
  method: string;
  params: unknown;
  /** Correlates a page-level call with the tab it belongs to. */
  tabId?: number;
}

export interface ResponseMessage {
  v: typeof PROTOCOL_VERSION;
  kind: 'res';
  id: string;
  result?: unknown;
  error?: BridgeErrorShape;
}

export interface EventMessage {
  v: typeof PROTOCOL_VERSION;
  kind: 'evt';
  event: string;
  data: unknown;
}

export type BridgeMessage = RequestMessage | ResponseMessage | EventMessage;

export type ErrorCode =
  | 'BAD_PARAMS'
  | 'NO_TAB'
  | 'NO_INSTANCE'
  | 'NO_MEMORY'
  | 'OUT_OF_RANGE'
  | 'SCAN_CLOSED'
  | 'NO_AGENT'
  | 'HOOK_EVAL_BLOCKED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'INTERNAL';

export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  toJSON(): BridgeErrorShape {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

export interface BridgeErrorShape {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

export function isBridgeError(value: unknown): value is { code: ErrorCode; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

export function isValueType(value: unknown): value is ValueType {
  return typeof value === 'string' && (VALUE_TYPES as readonly string[]).includes(value);
}

/** Method names. Kept in one place so both ends fail loudly on a typo. */
export const Methods = {
  // MCP server -> extension service worker
  extListTabs: 'ext.listTabs',
  extDetach: 'ext.detach',
  extEnsureAgent: 'ext.ensureAgent',
  extCall: 'ext.call',
  extPing: 'ext.ping',

  // extension service worker -> page agent
  pageHello: 'page.hello',
  pageListInstances: 'page.listInstances',
  pageListWorkers: 'page.listWorkers',
  pageRead: 'page.read',
  pageWrite: 'page.write',
  pageScanBegin: 'page.scan.begin',
  pageScanNext: 'page.scan.next',
  pageScanResults: 'page.scan.results',
  pageScanDrop: 'page.scan.drop',
  pageSavedList: 'page.saved.list',
  pageSavedSave: 'page.saved.save',
  pageSavedOpen: 'page.saved.open',
  pageSavedDelete: 'page.saved.delete',
  pageBookmarkList: 'page.bookmark.list',
  pageBookmarkAdd: 'page.bookmark.add',
  pageBookmarkRemove: 'page.bookmark.remove',
  pageBookmarkClear: 'page.bookmark.clear',
  pageSpeedSet: 'page.speed.set',
  pageSpeedStatus: 'page.speed.status',
  pageFreezeSet: 'page.freeze.set',
  pageFreezeClear: 'page.freeze.clear',
  pageFreezeList: 'page.freeze.list',
  pageWatchAdd: 'page.watch.add',
  pageWatchRemove: 'page.watch.remove',
  pageWatchList: 'page.watch.list',
  pageWatchPoll: 'page.watch.poll',
  pageHookAdd: 'page.hook.add',
  pageHookList: 'page.hook.list',
  pageHookSetEnabled: 'page.hook.setEnabled',
  pageHookRemove: 'page.hook.remove',
  pageTraceArm: 'page.trace.arm',
  pageTraceStop: 'page.trace.stop',
  pageTraceStatus: 'page.trace.status',
  pageTraceHits: 'page.trace.hits',
  pagePointerScan: 'page.pointer.scan',
  pagePointerResolve: 'page.pointer.resolve',
  pagePatchAdd: 'page.patch.add',
  pagePatchList: 'page.patch.list',
  pagePatchRemove: 'page.patch.remove',
  pagePatchClear: 'page.patch.clear',
} as const;

/** Events the service worker pushes to the MCP server. */
export const Events = {
  tabsChanged: 'tabs.changed',
  disconnected: 'bridge.disconnected',
  /**
   * A page agent event (see `PageRuntime.onEvent`), relayed untouched. It carries
   * `{ tabId, frameId, event, data }` so a caller can wait for one specific occurrence —
   * a watchpoint hit, for instance — instead of polling a status until it changes.
   */
  pageEvent: 'page.event',
  /**
   * One audit line, mirrored live so the DevTools panel can show it. The file on the host
   * stays the authoritative record; the extension only keeps a session-scoped ring buffer.
   */
  auditAppended: 'audit.appended',
  /**
   * The extension reports a mutation it just performed. Auditing here rather than in the MCP server
   * is what makes the log cover the DevTools panel too, which never touches the MCP server.
   */
  actionAudit: 'action.audit',
} as const;

/**
 * Structured clone accepts BigInt and cycles; JSON over the WebSocket does not. Everything
 * crossing the bridge goes through this so one stray BigInt can't kill a whole session.
 */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'bigint') return `${String(value)}n`;
  if (type === 'function') return '[function]';
  if (type === 'symbol') return String(value);
  if (type !== 'object') return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => jsonSafe(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${(value as Uint8Array).byteLength ?? 0}B]`;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = jsonSafe(item, depth + 1);
  }
  return out;
}

export function makeRequest(id: string, method: string, params: unknown, tabId?: number): RequestMessage {
  const msg: RequestMessage = { v: PROTOCOL_VERSION, kind: 'req', id, method, params };
  if (tabId !== undefined) msg.tabId = tabId;
  return msg;
}

export function makeResponse(id: string, result: unknown): ResponseMessage {
  return { v: PROTOCOL_VERSION, kind: 'res', id, result };
}

export function makeErrorResponse(id: string, error: unknown): ResponseMessage {
  const bridgeError = error instanceof BridgeError
    ? error.toJSON()
    : isBridgeError(error)
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL' as ErrorCode, message: error instanceof Error ? error.message : String(error) };
  return { v: PROTOCOL_VERSION, kind: 'res', id, error: bridgeError };
}

export function isRequest(message: unknown): message is RequestMessage {
  const m = message as Partial<RequestMessage> | null;
  return !!m && m.v === PROTOCOL_VERSION && m.kind === 'req' && typeof m.id === 'string' && typeof m.method === 'string';
}

export function isResponse(message: unknown): message is ResponseMessage {
  const m = message as Partial<ResponseMessage> | null;
  return !!m && m.v === PROTOCOL_VERSION && m.kind === 'res' && typeof m.id === 'string';
}

export function isEvent(message: unknown): message is EventMessage {
  const m = message as Partial<EventMessage> | null;
  return !!m && m.v === PROTOCOL_VERSION && m.kind === 'evt' && typeof m.event === 'string';
}

/** Addresses and numbers arrive from an LLM, so validate rather than trust. */
export function assertOffset(offset: unknown, byteLength: number, width: number): number {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new BridgeError('BAD_PARAMS', `offset must be a non-negative integer, got ${String(offset)}`);
  }
  if (offset + width > byteLength) {
    throw new BridgeError(
      'OUT_OF_RANGE',
      `address 0x${offset.toString(16)} (+${width} bytes) is outside memory of ${byteLength} bytes`,
    );
  }
  return offset;
}
