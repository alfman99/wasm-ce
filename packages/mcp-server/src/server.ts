import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  BridgeError,
  type Bookmark,
  type SavedScanSummary,
  Events,
  PATCH_MODES,
  TRACE_KINDS,
  VALUE_TYPES,
  formatAddress,
  parseAddress,
  type Address,
  type FreezeEntry,
  type SpeedStatus,
  type PatchEntry,
  type PointerPath,
  type PointerResolution,
  type HookEntry,
  type InstanceInfo,
  type PageDiagnostics,
  type ScriptResult,
  type PageAgentInfo,
  type ReadResult,
  type ScanHit,
  type ScanSummary,
  type TextScanResult,
  type TabInfo,
  type TraceKind,
  type ValueType,
  type WatchEntry,
  type WatchEvent,
  type WorkerInfo,
  type WriteTraceStatus,
  type WriteResult,
} from '@wasmcheat/protocol';
import { Bridge } from './bridge.js';
import { waitForPageEvent } from './events.js';
import { isAuditKind, onRecord, record, tail, type AuditLine } from './audit.js';

export type ToolResult = CallToolResult;

const VALUE_TYPE = z.enum(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']);
const SCAN_MODE = z.enum([
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
]);
const ADDRESS = z
  .string()
  .describe('Address in instance form, e.g. "w1:0x408" (offset may be hex or decimal).');

function ok(data: unknown, note?: string): ToolResult {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text: note ? `${note}\n\n${body}` : body }] };
}

function fail(error: unknown, note?: string): ToolResult {
  const text =
    error instanceof BridgeError
      ? `${error.code}: ${error.message}${error.detail ? `\n${JSON.stringify(error.detail, null, 2)}` : ''}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return { content: [{ type: 'text', text: note ? `${note}\n\n${text}` : text }], isError: true };
}

function addr(value: string): Address {
  try {
    return parseAddress(value);
  } catch (error) {
    throw new BridgeError('BAD_PARAMS', (error as Error).message);
  }
}

/** `1 match`, `3 matches`: tool notes and audit lines read as sentences. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function numeric(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new BridgeError('BAD_PARAMS', `"${String(value)}" is not a finite number`);
  return parsed;
}

function json<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))) as T;
}

/**
 * Every tool takes the tab id, and every tool can do without it: the tab in front is what a human
 * means by "this game". Listing tabs is only needed to reach a second one.
 */
const TAB_ID = z
  .number()
  .int()
  .optional()
  .describe('Tab id from wasmcheat_list_tabs. Omit for the tab in front.');

export function createServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: 'wasmcheat', version: '0.1.0' });

  // Mirror every appended audit line to the extension so the DevTools panel can show it: a
  // browser cannot read $WASMCHEAT_HOME/audit.jsonl, and this keeps `record` the one producer.
  onRecord((line) => bridge.send(Events.auditAppended, line));

  /**
   * The extension reports what it did, so the log covers the DevTools panel too — a human clicking
   * Freeze must appear exactly like an agent calling wasmcheat_freeze.
   */
  bridge.on(Events.actionAudit, (data) => {
    const line = data as Partial<AuditLine> | null;
    if (!line || !isAuditKind(line.kind) || typeof line.summary !== 'string') return;
    void record({
      kind: line.kind,
      ...(typeof line.tabId === 'number' ? { tabId: line.tabId } : {}),
      ok: line.ok !== false,
      summary: line.summary,
      ...(line.detail === undefined ? {} : { detail: line.detail }),
    });
  });

  /**
   * A tabId is optional everywhere: the tab in front is what a human means when they say "this game".
   * Listing is only needed to reach a second tab.
   */
  async function resolveTab(source: Bridge, asked?: number): Promise<number> {
    if (asked !== undefined) return asked;
    const tabs = await source.request<TabInfo[]>('ext.listTabs');
    const front = tabs.find((tab) => tab.active) ?? tabs[0];
    if (!front) {
      throw new BridgeError('NO_TAB', 'no http(s) tab is open; open the page you want to work on first');
    }
    return front.tabId;
  }

  /**
   * `instanceId: "latest"` means "whatever was instantiated last", resolved at call time.
   *
   * Real apps reload and re-instantiate their module, which mints new ids; an agent script that
   * hardcoded `w1` then fails for a reason it cannot see. Resolving late keeps a session usable
   * across the reloads that games and SPAs do all the time.
   */
  async function page<T>(tabId: number, method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    const resolved = await resolveInstance(tabId, params, timeoutMs);
    return bridge.request<T>('ext.call', { tabId, method, params: resolved, timeoutMs }, (timeoutMs ?? 30_000) + 5_000);
  }

  async function resolveInstance(tabId: number, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!params || typeof params !== 'object') return params;
    const record = params as Record<string, unknown>;
    if (record.instanceId !== 'latest') return record;
    const instances = await bridge.request<InstanceInfo[]>(
      'ext.call',
      { tabId, method: 'page.listInstances', params: {}, timeoutMs },
      (timeoutMs ?? 30_000) + 5_000,
    );
    const newest = instances[instances.length - 1];
    if (!newest) {
      throw new BridgeError(
        'NO_INSTANCE',
        'this tab has no wasm instance yet: attach with reload=true so the agent is in place before the module is compiled',
      );
    }
    return { ...record, instanceId: newest.id };
  }

  server.registerTool(
    'wasmcheat_list_tabs',
    {
      title: 'List browser tabs',
      description:
        'List the http(s) tabs the extension can see, with whether the page agent is already running in each. ' +
        'Every tool that takes a tabId defaults to the tab in front, so listing is only needed to reach a second tab. ' +
        'Wherever a tool asks for instanceId you may pass "latest" to mean whatever was instantiated last, which survives reloads.',
      inputSchema: {},
    },
    async () => {
      try {
        if (!bridge.connected) await bridge.waitForExtension(1_500);
        const tabs = await bridge.request<TabInfo[]>('ext.listTabs');
        return ok(tabs, tabs.length === 0 ? 'No http(s) tabs open. Open the page you want to work on first.' : undefined);
      } catch (error) {
        return fail(error, 'No extension connection.');
      }
    },
  );

  server.registerTool(
    'wasmcheat_attach',
    {
      title: 'Attach to a tab',
      description:
        'Start the page agent in a tab and list the WebAssembly instances it found. No approval step: the extension is ' +
        'installed by the person using the browser, and this call only starts doing work in a tab they already opened. ' +
        'If the page was loaded before the extension, the tab is reloaded once automatically (the answer says so, and ' +
        'every address from before that reload is stale).',
      inputSchema: {
        tabId: z.number().int().optional().describe('Tab id from wasmcheat_list_tabs. Defaults to the tab in front.'),
        reload: z
          .boolean()
          .optional()
          .describe('Reload the tab before attaching. Use when the page loaded before the extension did.'),
        frameId: z
          .number()
          .int()
          .optional()
          .describe(
            'Frame to drive, from wasmcheat_list_tabs frames[]. Omit to let the extension pick the frame that holds the wasm.',
          ),
      },
    },
    async ({ tabId: askedTab, reload, frameId }) => {
      let tabId = askedTab;
      try {
        tabId = await resolveTab(bridge, askedTab);
        const info = await bridge.request<PageAgentInfo>(
          'ext.ensureAgent',
          { tabId, reload, frameId },
          20_000,
        );
        const instances = await page<InstanceInfo[]>(tabId, 'page.listInstances');
        const engine =
          instances.length > 0
            ? (await page<PageDiagnostics>(tabId, 'page.diagnose').catch(() => undefined))?.physicsEngine
            : undefined;
        await record({
          kind: 'attach',
          tabId,
          ok: true,
          summary: `attached to ${info.url}`,
          detail: { instanceCount: instances.length, evalAllowed: info.evalAllowed },
        });
        return ok(
          { pageAgent: info, instances },
          [
            instances.length === 0
              ? 'Attached, but no WebAssembly instance was captured yet. If the app loaded before the extension, attach with reload=true.'
              : `Attached. ${count(instances.length, 'instance')} captured.`,
            // The extension reloads a page that predates the agent on its own; the agent should know
            // the document is new, because every address it had is gone.
            info.autoReloaded
              ? 'The extension reloaded the tab to install the page agent, so any scan or address from before is stale.'
              : undefined,
            engine
              ? `Every module here is ${engine}, a physics engine: scores, coins and game rules live in JavaScript and no scan will find them; only physics (bodies, forces, collisions) is in this memory.`
              : undefined,
          ]
            .filter(Boolean)
            .join(' '),
        );
      } catch (error) {
        await record({ kind: 'attach', tabId, ok: false, summary: (error as Error).message });
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_detach',
    {
      title: 'Detach from a tab',
      description:
        'Forget everything about a tab: hooks, patches, freezes and cached frames. The next call re-injects the agent.',
      inputSchema: { tabId: TAB_ID },
    },
    async ({ tabId: askedTab }) => {
      let tabId = askedTab;
      try {
        tabId = await resolveTab(bridge, askedTab);
        await bridge.request('ext.detach', { tabId });
        await record({ kind: 'detach', tabId, ok: true, summary: 'detached' });
        return ok({ tabId });
      } catch (error) {
        await record({ kind: 'detach', tabId, ok: false, summary: (error as Error).message });
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_list_instances',
    {
      title: 'List WebAssembly instances',
      description:
        'List the WebAssembly instances captured in a tab, with their id (w1, w2…), module hash, memory size and exports. ' +
        'Instances hosted by a Web Worker are included: they carry an id like k1-1, host "worker" and a workerId, and every ' +
        'tool that takes an instance id accepts them unchanged. Only function exports can be hooked.',
      inputSchema: { tabId: TAB_ID },
    },
    async ({ tabId: askedTab }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        return ok(await page<InstanceInfo[]>(tabId, 'page.listInstances'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_list_workers',
    {
      title: 'List Web Workers',
      description:
        'List the Web Workers the page agent bootstrapped in a tab: id (k1, k2…), the script URL the page asked for, ' +
        'classic or module, and how many WebAssembly instances each has captured. Engines that compile in a worker ' +
        '(Unity, Godot 4, many itch.io builds) show up here; their instances appear in list_instances as k1-1, k1-2… ' +
        'An empty list on a tab that clearly runs wasm means the worker was created before the agent loaded or is nested ' +
        'inside another worker; neither can be instrumented.',
      inputSchema: { tabId: TAB_ID },
    },
    async ({ tabId: askedTab }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        return ok(await page<WorkerInfo[]>(tabId, 'page.listWorkers'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_diagnose',
    {
      title: 'Why does this tab show no wasm?',
      description:
        'Explain what the page agent can and cannot see in a tab: how many times the app went through ' +
        'WebAssembly.instantiate, how many instances were captured, whether the document hosts a cross-origin ' +
        'iframe (a game in a subframe is invisible to the top-frame agent), any .wasm URLs in the markup, and ' +
        'whether the page allows eval (free-form hook bodies). Call this first when list_instances is empty.',
      inputSchema: { tabId: TAB_ID },
    },
    async ({ tabId: askedTab }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        return ok(await page<PageDiagnostics>(tabId, 'page.diagnose'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_scan',
    {
      title: 'Scan memory (and narrow a scan)',
      description:
        'Cheat Engine-style scan over one instance\'s linear memory. Without scanId it takes a fresh snapshot and filters it ' +
        '(mode "exact" needs a value; the other modes work on the snapshot alone). With scanId it narrows that earlier scan, ' +
        'which is the normal way to converge: begin with "exact" or "changed", then narrow with changed / increased / decreased ' +
        'after the value moves in the app. A first pass with a delta mode and no value is an unknown-value scan: every ' +
        'position stays a candidate (a copy of the memory, not a capped list), results are empty until a narrowing pass ' +
        'leaves at most a million. Returns a scanId and a match count; use wasmcheat_scan_results to read hits.',
      inputSchema: {
        tabId: TAB_ID,
        instanceId: z.string().describe('Instance id from wasmcheat_list_instances, e.g. "w1".'),
        type: VALUE_TYPE.describe('Value width to interpret memory as.'),
        mode: SCAN_MODE.optional().describe('Filter for this pass (default "exact" when a value is given, else "changed").'),
        value: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'Target of the comparison: the value for exact/not-equal/less/greater/increased-by/decreased-by, the lower bound for between.',
          ),
        value2: z.union([z.number(), z.string()]).optional().describe('Upper bound, for mode "between" only.'),
        tolerance: z.number().min(0).optional().describe('Allowed absolute difference for float scans.'),
        alignment: z
          .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
          .optional()
          .describe('Step between candidate offsets. Defaults to the type width; use 1 to catch unaligned data.'),
        maxResults: z.number().int().min(1).max(250_000).optional(),
        scanId: z.string().optional().describe('Narrow this existing scan instead of starting a new one.'),
        from: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Start of the byte range to scan (default 0). Use it to skip a huge zero-initialised heap.'),
        to: z.number().int().min(1).optional().describe('End of the byte range to scan, exclusive (default: memory size).'),
      },
    },
    async ({ tabId: askedTab, instanceId, type, mode, value, value2, tolerance, alignment, maxResults, scanId, from, to }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const parsedValue = numeric(value);
        const parsedValue2 = numeric(value2);
        const effectiveMode = mode ?? (parsedValue === undefined ? 'changed' : 'exact');
        if (to !== undefined && from !== undefined && to <= from) {
          return fail(new BridgeError('BAD_PARAMS', 'to must be greater than from'));
        }
        const range = from === undefined && to === undefined ? undefined : { start: from ?? 0, end: to };
        const summary = scanId
          ? await page<ScanSummary>(tabId, 'page.scan.next', {
              scanId,
              mode: effectiveMode,
              value: parsedValue,
              value2: parsedValue2,
              tolerance,
            })
          : await page<ScanSummary>(tabId, 'page.scan.begin', {
              instanceId,
              type,
              mode: effectiveMode,
              value: parsedValue,
              value2: parsedValue2,
              tolerance,
              alignment,
              maxResults,
              range,
            });

        const formatted = {
          ...summary,
          sample: summary.sample.map((hit: ScanHit) => ({ address: formatAddress(hit.address), value: hit.value })),
        };
        const note =
          summary.matchCount === 0
            ? 'No matches left. Change the value in the app and narrow again, or begin a new scan.'
            : summary.truncated
              ? `Truncated at ${summary.matchCount} hits; raise maxResults or narrow with a range.`
              : undefined;
        return ok(formatted, note);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_scan_text',
    {
      title: 'Search memory for text',
      description:
        'Byte search for a string in linear memory: names, ids, prices and labels that a numeric scan can never find. ' +
        'encoding "ascii" (default) or "utf8" for text, "bytes" for a hex needle like "deadbeef". Returns matching ' +
        'offsets you can read with wasmcheat_read.',
      inputSchema: {
        tabId: TAB_ID,
        instanceId: z.string().describe('Instance id from wasmcheat_list_instances, e.g. "w1".'),
        text: z.string().min(1).describe('Text to find, or a hex string when encoding is "bytes".'),
        encoding: z.enum(['ascii', 'utf8', 'bytes']).optional().describe('How to encode the needle (default "ascii").'),
        caseSensitive: z.boolean().optional().describe('Default true; set false to fold ASCII case.'),
        from: z.number().int().min(0).optional().describe('Start offset in bytes (default 0).'),
        to: z.number().int().min(0).optional().describe('End offset in bytes (default end of memory).'),
        maxResults: z.number().int().min(1).max(250_000).optional(),
      },
    },
    async ({ tabId: askedTab, instanceId, text, encoding, caseSensitive, from, to, maxResults }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const result = await page<TextScanResult>(tabId, 'page.scan.text', {
          instanceId,
          text,
          encoding,
          caseSensitive,
          range: from === undefined && to === undefined ? undefined : { start: from ?? 0, end: to ?? Number.MAX_SAFE_INTEGER },
          maxResults,
        });
        return ok(
          {
            ...result,
            // Addresses of the *start* of each match, ready for wasmcheat_read.
            addresses: result.matches.map((offset) => formatAddress({ instanceId, offset })),
          },
          result.total === 0 ? 'No matches. Try a shorter needle, another encoding, or encoding "bytes" for raw bytes.' : undefined,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_scan_results',
    {
      title: 'Read scan hits',
      description:
        'Page through the hits of a scan: value is current memory, previous is the value at the last scan pass (they differ for addresses that moved since).',
      inputSchema: {
        tabId: TAB_ID,
        scanId: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ tabId: askedTab, scanId, offset, limit }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const result = await page<{ hits: { address: Address; value: number; previous?: number }[]; total: number }>(
          tabId,
          'page.scan.results',
          { scanId, offset, limit },
        );
        return ok({
          ...result,
          hits: result.hits.map((hit) => ({ address: formatAddress(hit.address), value: hit.value, previous: hit.previous })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_scan_drop',
    {
      title: 'Drop a scan',
      description: 'Free the memory held by a scan session. Do this when you are done with it.',
      inputSchema: { tabId: TAB_ID, scanId: z.string() },
    },
    async ({ tabId: askedTab, scanId }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        return ok({ dropped: await page<boolean>(tabId, 'page.scan.drop', { scanId }) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_saved',
    {
      title: 'Save, list, re-open and delete scan lists',
      description:
        'A scan session dies with the page, and narrowing 40,000 candidates down to six is the slow part of ' +
        'the job. Saving keeps the surviving addresses under a name in the page, so after a reload you re-open ' +
        'the list and keep narrowing instead of starting over. Actions: list, save (needs scanId and name), ' +
        'open (needs name; returns a new scanId), delete (needs name).',
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['list', 'save', 'open', 'delete']),
        name: z.string().min(1).max(64).optional(),
        scanId: z.string().optional().describe('Session to save (action save).'),
        instanceId: z.string().optional().describe('Instance to attach an opened list to (default: the saved one).'),
      },
    },
    async ({ tabId: askedTab, action, name, scanId, instanceId }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'list') return ok(await page<SavedScanSummary[]>(tabId, 'page.saved.list'));
        if (action === 'delete') {
          if (!name) return fail(new BridgeError('BAD_PARAMS', 'name is required for delete'));
          const deleted = await page<boolean>(tabId, 'page.saved.delete', { name });
          record({
            kind: 'scan',
            tabId,
            ok: deleted,
            summary: deleted ? `deleted saved scan "${name}"` : `no saved scan "${name}" to delete`,
          });
          return ok({ deleted, name });
        }
        if (action === 'save') {
          if (!name) return fail(new BridgeError('BAD_PARAMS', 'name is required for save'));
          if (!scanId) return fail(new BridgeError('BAD_PARAMS', 'scanId is required for save'));
          const saved = await page<SavedScanSummary>(tabId, 'page.saved.save', { name, scanId });
          record({ kind: 'scan', tabId, ok: true, summary: `saved scan "${saved.name}" (${count(saved.matchCount, 'match', 'matches')})` });
          return ok(saved, `saved ${count(saved.matchCount, 'address', 'addresses')} as "${saved.name}"; it survives a reload of this tab`);
        }
        if (!name) return fail(new BridgeError('BAD_PARAMS', 'name is required for open'));
        const opened = await page<{ scanId: string; instanceId: string; summary: ScanSummary }>(tabId, 'page.saved.open', {
          name,
          ...(instanceId ? { instanceId } : {}),
        });
        record({ kind: 'scan', tabId, ok: true, summary: `re-opened saved scan "${name}" (${count(opened.summary.matchCount, 'match', 'matches')})` });
        return ok(
          { ...opened.summary, scanId: opened.scanId, instanceId: opened.instanceId, name },
          `narrow it with wasmcheat_scan {scanId: "${opened.scanId}", mode: "changed"}`,
        );
      } catch (error) {
        if (action !== 'list') {
          await record({ kind: 'scan', tabId, ok: false, summary: `${action} saved scan "${name}": ${(error as Error).message}` });
        }
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_bookmark',
    {
      title: 'Keep a named address (address list)',
      description:
        'Cheat Engine keeps an address list; this is that. Bookmarks are a label, an address and an optional type, ' +
        'stored in the page\'s local storage so they outlive a reload (they are per site). Actions: list, add ' +
        '(needs label and address; adding an existing label replaces it), remove (id or label), clear.',
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['list', 'add', 'remove', 'clear']),
        label: z.string().min(1).max(64).optional().describe('Name a human would recognise, for example "score".'),
        address: ADDRESS.optional().describe('Address from a scan, a read or wasmcheat_scan_results.'),
        type: VALUE_TYPE.optional().describe('Value width to remember alongside the address.'),
        note: z.string().max(200).optional().describe('Free-form note, for example "mirrors 0x40c".'),
        id: z.string().optional().describe('Bookmark id (or label) for remove.'),
      },
    },
    async ({ tabId: askedTab, action, label, address, type, note, id }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'list') {
          const bookmarks = await page<Bookmark[]>(tabId, 'page.bookmark.list');
          return ok(bookmarks, bookmarks.length === 0 ? 'no bookmarks yet: add one with an address you found' : undefined);
        }
        if (action === 'clear') {
          const cleared = await page<{ removed: number }>(tabId, 'page.bookmark.clear');
          return ok(cleared);
        }
        if (action === 'remove') {
          const target = id ?? label;
          if (!target) return fail(new BridgeError('BAD_PARAMS', 'remove needs id (or label)'));
          const removed = await page<boolean>(tabId, 'page.bookmark.remove', { id: target });
          return ok({ removed, target });
        }
        if (!label) return fail(new BridgeError('BAD_PARAMS', 'label is required for add'));
        if (!address) return fail(new BridgeError('BAD_PARAMS', 'address is required for add'));
        const bookmark = await page<Bookmark>(tabId, 'page.bookmark.add', { label, address, ...(type ? { type } : {}), ...(note ? { note } : {}) });
        return ok(bookmark, `remembered as "${bookmark.label}"; use it any time with wasmcheat_read {address: "${bookmark.address}"}`);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_read',
    {
      title: 'Read memory',
      description:
        'Read typed values at an address, or raw bytes with `length` (returned as hex). Use count to read an array of values.',
      inputSchema: {
        tabId: TAB_ID,
        address: ADDRESS,
        type: VALUE_TYPE.optional().describe('Value width (required unless you pass length).'),
        count: z.number().int().min(1).max(1024).optional(),
        length: z.number().int().min(1).max(4096).optional().describe('Read this many raw bytes instead of values.'),
      },
    },
    async ({ tabId: askedTab, address, type, count, length }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const result = await page<ReadResult>(tabId, 'page.read', {
          address: addr(address),
          type: type ?? 'u8',
          count,
          length,
        });
        return ok({ ...result, address: address });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_write',
    {
      title: 'Write memory',
      description:
        'Write one typed value to memory. Every write is appended to the audit log. Returns the value before and after, so you can confirm it landed.',
      inputSchema: {
        tabId: TAB_ID,
        address: ADDRESS,
        type: VALUE_TYPE,
        value: z
          .union([z.number(), z.string()])
          .describe('New value. Integers are wrapped to the type width; floats are stored as the nearest f32/f64.'),
      },
    },
    async ({ tabId: askedTab, address, type, value }) => {
      const tabId = await resolveTab(bridge, askedTab);
      const parsed = numeric(value);
      if (parsed === undefined) return fail(new BridgeError('BAD_PARAMS', 'value is required'));
      try {
        const target = addr(address);
        const result = await page<WriteResult>(tabId, 'page.write', { address: target, type, value: parsed });
        return ok({ ...result, address });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_freeze',
    {
      title: 'Freeze / unfreeze / list addresses',
      description:
        'Freeze keeps re-writing a value every 16ms so the app cannot change it (the classic "infinite health"). ' +
        'Actions: set (needs address, type, value), clear (needs freezeId), list.',
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['set', 'clear', 'list']),
        address: ADDRESS.optional(),
        type: VALUE_TYPE.optional(),
        value: z.union([z.number(), z.string()]).optional(),
        freezeId: z.string().optional(),
      },
    },
    async ({ tabId: askedTab, action, address, type, value, freezeId }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'list') return ok(await page<FreezeEntry[]>(tabId, 'page.freeze.list'));
        if (action === 'clear') {
          if (!freezeId) return fail(new BridgeError('BAD_PARAMS', 'freezeId is required for clear'));
          const cleared = await page<boolean>(tabId, 'page.freeze.clear', { freezeId });
          return ok({ cleared });
        }
        if (!address || !type) return fail(new BridgeError('BAD_PARAMS', 'address and type are required for set'));
        const target = addr(address);
        const parsed = numeric(value);
        if (parsed === undefined) return fail(new BridgeError('BAD_PARAMS', 'value is required for set'));
        const entry = await page<FreezeEntry>(tabId, 'page.freeze.set', { address: target, type, value: parsed });
        return ok(entry);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_speed',
    {
      title: 'Speed hack: scale the page clock',
      description:
        'Multiplies the time the page perceives, without editing the game: `performance.now()`, `Date.now()` and the timestamp ' +
        'given to `requestAnimationFrame` all run at `scale`x. 1 is real time, 0 stops the simulation (a paused game you can ' +
        'still scan), 3 is three times faster. Only the page realm is scaled; workers keep real time. Omit `scale` to read the ' +
        'current setting, use `reset: true` (or scale 1) to go back.',
      inputSchema: {
        tabId: TAB_ID,
        scale: z.number().min(0).max(20).optional().describe('Multiplier, 0..20. Omit to just report the current scale.'),
        reset: z.boolean().optional().describe('Return to real time (same as scale 1).'),
      },
    },
    async ({ tabId: askedTab, scale, reset }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (reset === true || scale !== undefined) {
          const requested = reset === true ? 1 : (scale as number);
          const status = await page<SpeedStatus>(tabId, 'page.speed.set', { scale: requested });
          return ok(status, `${status.scale}x ${status.scale === 1 ? '(real time)' : 'simulation speed'}`);
        }
        return ok(await page<SpeedStatus>(tabId, 'page.speed.status', {}));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_watch',
    {
      title: 'Watch an address',
      description:
        'Track an address and collect change events (polled every 50ms). Actions: add (needs address, type), remove (needs watchId), ' +
        'list, poll (drain buffered change events).',
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['add', 'remove', 'list', 'poll']),
        address: ADDRESS.optional(),
        type: VALUE_TYPE.optional(),
        watchId: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ tabId: askedTab, action, address, type, watchId, limit }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'list') return ok(await page<WatchEntry[]>(tabId, 'page.watch.list'));
        if (action === 'poll') {
          const events = await page<WatchEvent[]>(tabId, 'page.watch.poll', { limit });
          return ok(
            events.map((event) => ({
              ...event,
              address: formatAddress(event.address),
            })),
          );
        }
        if (action === 'remove') {
          if (!watchId) return fail(new BridgeError('BAD_PARAMS', 'watchId is required for remove'));
          return ok({ removed: await page<boolean>(tabId, 'page.watch.remove', { watchId }) });
        }
        if (!address || !type) return fail(new BridgeError('BAD_PARAMS', 'address and type are required for add'));
        return ok(await page<WatchEntry>(tabId, 'page.watch.add', { address: addr(address), type }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  /**
   * The write breakpoint, for reads and writes alike: arm the watchpoint, reload so the module is
   * instrumented as it loads, then wait for the page to report its first access as an event.
   */
  async function findAccess(
    kind: TraceKind,
    args: {
      tabId?: number;
      address: string;
      type?: ValueType;
      maxHits?: number;
      timeoutSeconds?: number;
      reload?: boolean;
    },
  ): Promise<ToolResult> {
    const tabId = await resolveTab(bridge, args.tabId);
    const { address, type, maxHits, timeoutSeconds, reload } = args;
    try {
      const target = addr(address);
      const formatted = formatAddress(target);
      const wait = (timeoutSeconds ?? 15) * 1000;
      // The wait ends on the event the page agent emits when the instrumented module touches the
      // address, so subscribe before arming: an access during the app's own boot would otherwise
      // happen before the first status read could see it. The bound only stops a stuck call; a
      // page that never touches the address is a result, so a timeout is swallowed and the status
      // below reports it exactly as it always has.
      const hit = waitForPageEvent(bridge, tabId, 'trace.hit', { timeoutMs: wait }).then(
        () => undefined,
        () => undefined,
      );
      await bridge.request('ext.traceArm', {
        tabId,
        address: formatted,
        kind,
        ...(type ? { type } : {}),
        ...(maxHits ? { maxHits } : {}),
      });
      if (reload !== false) {
        await bridge.request('ext.reload', { tabId }, 60_000);
      }
      await hit;
      const status = await page<WriteTraceStatus>(tabId, 'page.trace.status');
      const verb = kind === 'read' ? 'reads' : 'writes';
      const past = kind === 'read' ? 'read' : 'wrote';
      record({
        kind: 'trace',
        tabId,
        ok: true,
        summary: `watched ${verb} to ${formatted} (${count(status.hits.length, 'hit')})`,
        detail: { kind, hits: status.hits, installed: status.installed },
      });
      const note = status.installed
        ? status.hits.length > 0
          ? `${count(status.functions.length, 'function')} ${past} ${formatted}`
          : `no ${verb} to ${formatted} were seen in ${(wait / 1000).toFixed(0)}s; the page may not touch it until you interact with it`
        : `the watchpoint never installed${status.note ? `: ${status.note}` : ''}`;
      return ok({ ...status, writers: status.functions }, note);
    } catch (error) {
      return fail(error);
    }
  }

  server.registerTool(
    'wasmcheat_find_writes',
    {
      title: 'Find what writes to an address',
      description:
        "Answers \"which function writes here?\": Cheat Engine's write breakpoint, for wasm. WebAssembly has no write events, " +
        'so the tab is reloaded with an instrumented module: every store then calls back with the function index that made it. ' +
        'Returns every hit with the function that wrote and the value before/after.',
      inputSchema: {
        tabId: TAB_ID,
        address: ADDRESS,
        type: VALUE_TYPE.optional(),
        maxHits: z.number().int().min(1).max(500).optional(),
        timeoutSeconds: z.number().int().min(1).max(120).optional(),
        reload: z.boolean().optional(),
      },
    },
    (args) => findAccess('write', args),
  );

  server.registerTool(
    'wasmcheat_find_reads',
    {
      title: 'Find what reads an address',
      description:
        'Answers "which function reads here?": Cheat Engine\'s read breakpoint, for wasm. Every load in the module gains a small ' +
        'guarded call that reports the address it is about to read, so the tab is reloaded once with the instrumented module ' +
        'Reads are the better question for input flags, timers and health checks: the reader ' +
        'is the code that decides what the value means.',
      inputSchema: {
        tabId: TAB_ID,
        address: ADDRESS,
        type: VALUE_TYPE.optional(),
        maxHits: z.number().int().min(1).max(500).optional(),
        timeoutSeconds: z.number().int().min(1).max(120).optional(),
        reload: z.boolean().optional(),
      },
    },
    (args) => findAccess('read', args),
  );

  /**
   * A patch is applied when a module is instantiated with it. The reload returns as soon as the
   * page agent is alive, which is before the app has fetched and compiled its wasm, so give the
   * instantiation a moment before claiming the patch is still pending.
   */
  async function waitForPatches(tabId: number, patchId: string, waitMs = 10_000): Promise<PatchEntry[]> {
    const deadline = Date.now() + waitMs;
    let list = await page<PatchEntry[]>(tabId, 'page.patch.list');
    while (Date.now() < deadline && !list.some((item) => item.id === patchId && item.applied)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      list = await page<PatchEntry[]>(tabId, 'page.patch.list');
    }
    return list;
  }

  server.registerTool(
    'wasmcheat_pointer_scan',
    {
      title: 'Find pointer paths to an address',
      description:
        'Finds chains of pointers that reach an address: read the base, add an offset, follow that value, add another offset, ' +
        'until you arrive. Use it when an address you found by scanning changes after a reload or after the app reallocates: ' +
        'the address moves, the chain does not. Returns the shortest chains first; `base` is where the chain starts (a likely ' +
        'static location), `offsets` are applied in order. In wasm every pointer is a 32-bit index into the same linear memory, ' +
        'so the scan needs no module bases or rebasing. Verify a chain with wasmcheat_pointer_resolve before trusting it.',
      inputSchema: {
        tabId: TAB_ID,
        address: ADDRESS,
        maxDepth: z.number().int().min(1).max(6).optional(),
        maxOffset: z.number().int().min(4).max(0x100000).optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ tabId: askedTab, address, maxDepth, maxOffset, maxResults }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const target = addr(address);
        const paths = await page<PointerPath[]>(tabId, 'page.pointer.scan', {
          instanceId: target.instanceId,
          offset: target.offset,
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          ...(maxOffset !== undefined ? { maxOffset } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        });
        const chains = paths.map((path) => ({
          base: formatAddress(path.base),
          offsets: path.offsets,
          depth: path.depth,
          read: `[${formatAddress(path.base)}] + ${path.offsets.join(' + ')} -> ${formatAddress(path.target)}`,
        }));
        const note =
          paths.length === 0
            ? `no pointer chain reaches ${formatAddress(target)} within ${count(maxDepth ?? 3, 'hop')} and ${maxOffset ?? 0x400} bytes per hop; raise maxDepth or maxOffset`
            : `${count(paths.length, 'chain')}, shortest first; the first base is the most likely static anchor`;
        return ok({ address: formatAddress(target), chains }, note);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_pointer_resolve',
    {
      title: 'Resolve a pointer path',
      description:
        'Walks one chain from wasmcheat_pointer_scan and reports every hop (address + value) and the value at the end. A hop whose ' +
        'value is no longer a plausible address means the chain broke (the app reallocated, or the base moved).',
      inputSchema: {
        tabId: TAB_ID,
        base: ADDRESS,
        offsets: z.array(z.number().int().min(0)).min(1).max(6),
      },
    },
    async ({ tabId: askedTab, base, offsets }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const start = addr(base);
        const resolution = await page<PointerResolution>(tabId, 'page.pointer.resolve', {
          instanceId: start.instanceId,
          base: start.offset,
          offsets,
        });
        const note =
          resolution.value === null
            ? 'the chain left linear memory before the last offset'
            : `${formatAddress(start)} + ${offsets.join(' + ')} reaches ${resolution.final} = ${resolution.value}`;
        return ok(resolution, note);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_patch',
    {
      title: 'Patch a wasm function body',
      description:
        "Switches off behaviour the module keeps to itself (a damage routine, a cooldown, a check), which no hook can reach " +
        "because it is neither exported nor imported. `add` stubs a function out (`mode: 'stub'` returns `value`, default 0; " +
        "`mode: 'empty'` is for void functions) and reloads the tab so the module is rewritten as it loads: the stub is in the " +
        "binary itself, so every caller is affected and no JS object is involved. `target` is an export name or " +
        "'wasm-function[N]' from list_instances. Patches stay until removed and survive reloads via sessionStorage. A compiled " +
        "module can never be patched in place, so `applied` is false until the reload that installs it.",
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['add', 'list', 'remove', 'clear']),
        target: z.string().optional(),
        mode: z.enum([...PATCH_MODES]).optional(),
        value: z.number().optional(),
        note: z.string().optional(),
        patchId: z.string().optional(),
        reload: z.boolean().optional(),
      },
    },
    async ({ tabId: askedTab, action, target, mode, value, note, patchId, reload }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'list') return ok(await page<PatchEntry[]>(tabId, 'page.patch.list'));
        if (action === 'clear') {
          const list = await page<PatchEntry[]>(tabId, 'page.patch.clear');
          if (reload !== false) await bridge.request('ext.reload', { tabId }, 60_000);
          return ok(list, 'every patch removed; the reload put the original functions back');
        }
        if (action === 'remove') {
          if (!patchId) return fail(new BridgeError('BAD_PARAMS', 'patchId is required for remove'));
          const list = await page<PatchEntry[]>(tabId, 'page.patch.remove', { patchId });
          if (reload !== false) await bridge.request('ext.reload', { tabId }, 60_000);
          return ok(list, 'removed; the reload put the original function back');
        }
        if (!target) return fail(new BridgeError('BAD_PARAMS', 'target is required for add'));
        const entry = await page<PatchEntry>(tabId, 'page.patch.add', {
          target,
          mode: mode ?? 'stub',
          ...(value !== undefined ? { value } : {}),
          ...(note ? { note } : {}),
        });
        if (reload !== false) await bridge.request('ext.reload', { tabId }, 60_000);
        // The agent is injected at document_start, before the app fetches its module, so wait for
        // the instantiation that actually applies the patch instead of reporting "pending" always.
        const list = await waitForPatches(tabId, entry.id);
        // The entry from `add` predates the reload; the list is what the page agent re-applied.
        const fresh = list.find((item) => item.id === entry.id) ?? entry;
        const applied = fresh.applied;
        const installed = applied
          ? `${target} now returns ${entry.value ?? 0} to every caller`
          : `${target} is patched for the next instantiation${reload === false ? ' (reload the tab to install it)' : '; no instance has been created since'}`;
        return ok({ patch: fresh, patches: list }, installed);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_trace',
    {
      title: 'Write watchpoint control',
      description:
        'Low-level control for find_writes / find_reads. arm (needs tabId + address, optional kind read|write) installs the ' +
        'watchpoint for the next instantiation and remembers it across a reload, status reports whether it installed, poll ' +
        'drains the collected hits, clear resets them, stop removes the watchpoint entirely.',
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['arm', 'status', 'poll', 'clear', 'stop']),
        address: ADDRESS.optional(),
        type: VALUE_TYPE.optional(),
        maxHits: z.number().int().min(1).max(500).optional(),
        kind: z.enum([...TRACE_KINDS]).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ tabId: askedTab, action, address, type, maxHits, kind, limit }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'arm') {
          if (!address) return fail(new BridgeError('BAD_PARAMS', 'address is required for arm'));
          const status = await bridge.request<WriteTraceStatus>('ext.traceArm', {
            tabId,
            address: formatAddress(addr(address)),
            ...(type ? { type } : {}),
            ...(maxHits ? { maxHits } : {}),
            ...(kind ? { kind } : {}),
          });
          return ok(status, 'armed; it takes effect the next time the page instantiates its wasm');
        }
        if (action === 'stop') return ok(await page<WriteTraceStatus>(tabId, 'page.trace.stop'));
        if (action === 'clear') return ok(await page<WriteTraceStatus>(tabId, 'page.trace.clear'));
        if (action === 'poll') {
          return ok(await page<WriteTraceStatus>(tabId, 'page.trace.hits', { limit }));
        }
        return ok(await page<WriteTraceStatus>(tabId, 'page.trace.status'));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_hook',
    {
      title: 'Hook an export or import',
      description:
        'Inject a JS hook into a running instance, with no reload. Actions: add, list, enable, remove.\n' +
        'Export hooks are live: the body is compiled as `function(args, ctx)` and replaces what the app calls. ' +
        'Inside it, `args` is the argument array and `ctx.call(nextArgs?)` invokes the original; return a value to override it, ' +
        'return nothing (or do not call ctx.call) to pass the original result through.\n' +
        'Import hooks apply to the *next* instantiation of a module importing that name ("env.log"); WebAssembly binds imports ' +
        'at instantiation, so an already-running instance cannot be re-patched (the response says pending: true).\n' +
        'Every add/remove is audited. If the page forbids eval, pass `fallback` for a declarative behaviour.',
      inputSchema: {
        tabId: TAB_ID,
        action: z.enum(['add', 'list', 'enable', 'remove']),
        instanceId: z.string().optional(),
        target: z.enum(['export', 'import']).optional(),
        name: z.string().optional().describe('Export name, or "module.import" for imports.'),
        body: z.string().optional().describe('JS body of function(args, ctx).'),
        fallback: z
          .object({
            mode: z.enum(['passthrough', 'replace-return', 'offset-result']),
            value: z.number().optional(),
          })
          .optional(),
        note: z.string().optional().describe('Why this hook exists; copied into the audit log.'),
        hookId: z.string().optional(),
        enabled: z.boolean().optional(),
      },
    },
    async ({ tabId: askedTab, action, instanceId, target, name, body, fallback, note, hookId, enabled }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        if (action === 'list') return ok(await page<HookEntry[]>(tabId, 'page.hook.list'));
        if (action === 'enable') {
          if (!hookId || enabled === undefined) {
            return fail(new BridgeError('BAD_PARAMS', 'hookId and enabled are required for enable'));
          }
          return ok(await page<HookEntry>(tabId, 'page.hook.setEnabled', { hookId, enabled }));
        }
        if (action === 'remove') {
          if (!hookId) return fail(new BridgeError('BAD_PARAMS', 'hookId is required for remove'));
          const removed = await page<boolean>(tabId, 'page.hook.remove', { hookId });
          return ok({ removed });
        }

        if (!instanceId || !target || !name || body === undefined) {
          return fail(new BridgeError('BAD_PARAMS', 'instanceId, target, name and body are required for add'));
        }
        const entry = await page<HookEntry>(tabId, 'page.hook.add', {
          instanceId,
          target,
          name,
          body,
          fallback,
          note,
        });
        return ok(
          entry,
          entry.target === 'import' && entry.pending
            ? 'Registered, but pending: imports bind at instantiation, so this applies the next time the page instantiates a module importing it.'
            : undefined,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_run_script',
    {
      title: 'Run JavaScript in the game frame',
      description:
        'Runs code in the frame that holds the wasm (the game frame, even inside a cross-origin iframe), for what lives in ' +
        "the game's JavaScript rather than in its memory: a PlayCanvas or three.js scene, a Unity instance, a game's own " +
        'debug switches. `code` is an expression whose value comes back (an IIFE pasted from a console works) or a ' +
        'function body that `return`s one; both may await. The value is returned JSON-safe and cut at 64 KB. Every run is ' +
        'audited with its code. A page whose CSP forbids eval answers HOOK_EVAL_BLOCKED. Find what to touch first, ' +
        'e.g. `Object.keys(window)` or `pc.app.root.children.map((e) => e.name)`.',
      inputSchema: {
        tabId: TAB_ID,
        code: z.string().min(1).describe('An expression, or a function body that returns a value.'),
        timeoutSeconds: z.number().int().min(1).max(120).optional().describe('How long an awaiting script may take (default 30).'),
      },
    },
    async ({ tabId: askedTab, code, timeoutSeconds }) => {
      const tabId = await resolveTab(bridge, askedTab);
      try {
        const result = await page<ScriptResult>(tabId, 'page.script.run', { code }, (timeoutSeconds ?? 30) * 1000);
        return ok(result, result.truncated ? 'The value was cut at 64 KB; return a smaller part of it.' : undefined);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_audit',
    {
      title: 'Read the audit log',
      description: 'Return the most recent audit entries (every write, freeze and hook, plus attaches and approvals).',
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
    },
    async ({ limit }) => {
      try {
        const lines = await tail(limit ?? 25);
        if (lines.length === 0) return ok('The audit log is empty.');
        return ok(json(lines.map((line) => JSON.parse(line))));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
