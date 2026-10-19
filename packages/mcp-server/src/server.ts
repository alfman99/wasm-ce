import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  BridgeError,
  VALUE_TYPES,
  formatAddress,
  parseAddress,
  type Address,
  type ApprovalState,
  type FreezeEntry,
  type HookEntry,
  type InstanceInfo,
  type PageDiagnostics,
  type PageAgentInfo,
  type ReadResult,
  type ScanHit,
  type ScanSummary,
  type TextScanResult,
  type TabInfo,
  type ValueType,
  type WatchEntry,
  type WatchEvent,
  type WriteTraceStatus,
  type WriteResult,
} from '@wasmcheat/protocol';
import { Bridge } from './bridge.js';
import { record, tail } from './audit.js';

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

function numeric(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new BridgeError('BAD_PARAMS', `"${String(value)}" is not a finite number`);
  return parsed;
}

function json<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))) as T;
}

export function createServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: 'wasmcheat', version: '0.1.0' });

  /** Forward a page-level method through the extension's approval gate. */
  async function page<T>(tabId: number, method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    return bridge.request<T>('ext.call', { tabId, method, params, timeoutMs }, (timeoutMs ?? 30_000) + 5_000);
  }

  server.registerTool(
    'wasmcheat_list_tabs',
    {
      title: 'List browser tabs',
      description:
        'List the http(s) tabs the WasmCheat extension can see, with each tab\'s approval state and whether the page agent is already running. ' +
        'Start here: you need a tabId for every other tool.',
      inputSchema: {},
    },
    async () => {
      try {
        if (!bridge.connected) await bridge.waitForExtension(1_500);
        const tabs = await bridge.request<TabInfo[]>('ext.listTabs');
        const pending = tabs.filter((tab) => tab.approval === 'pending').length;
        return ok(tabs, pending > 0 ? `${pending} tab(s) waiting for the human to approve in the extension popup.` : undefined);
      } catch (error) {
        return fail(error, 'No extension connection.');
      }
    },
  );

  server.registerTool(
    'wasmcheat_attach',
    {
      title: 'Attach to a tab (needs human approval)',
      description:
        'Ask the human to approve a tab, then start the page agent in it. Blocks while the request waits for approval ' +
        '(default 60s) and returns NEED_APPROVAL if the human has not answered yet — in that case tell the user to click the ' +
        'WasmCheat toolbar icon, approve the tab, then retry. Nothing can read or write memory until this succeeds.',
      inputSchema: {
        tabId: z.number().int().describe('Tab id from wasmcheat_list_tabs.'),
        reason: z.string().optional().describe('One line shown to the human explaining what you intend to do.'),
        waitSeconds: z.number().min(0).max(120).optional().describe('How long to wait for the human (default 60).'),
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
    async ({ tabId, reason, waitSeconds, reload, frameId }) => {
      const waitMs = (waitSeconds ?? 60) * 1_000;
      try {
        const approval = await bridge.request<{ requestId: string; state: ApprovalState; tab?: { title: string; url: string } }>(
          'ext.requestApproval',
          { tabId, reason, waitMs },
          waitMs + 15_000,
        );
        if (approval.state !== 'granted') {
          await record({ kind: 'approval', tabId, ok: false, summary: `approval ${approval.state}`, detail: { reason } });
          return fail(
            new BridgeError(
              'NEED_APPROVAL',
              approval.state === 'pending'
                ? `still waiting for the human to approve tab ${tabId}`
                : `the human denied tab ${tabId}`,
              { requestId: approval.requestId, tab: approval.tab },
            ),
            'Ask the user to approve this tab in the WasmCheat popup, then call wasmcheat_attach again.',
          );
        }

        const info = await bridge.request<PageAgentInfo>(
          'ext.ensureAgent',
          { tabId, reload, frameId },
          20_000,
        );
        const instances = await page<InstanceInfo[]>(tabId, 'page.listInstances');
        await record({
          kind: 'attach',
          tabId,
          ok: true,
          summary: `attached to ${approval.tab?.url ?? 'tab'}`,
          detail: { instanceCount: instances.length, evalAllowed: info.evalAllowed },
        });
        return ok(
          { approval, pageAgent: info, instances },
          instances.length === 0
            ? 'Attached, but no WebAssembly instance was captured yet. If the app loaded before the extension, attach with reload=true.'
            : `Attached. ${instances.length} instance(s) captured.`,
        );
      } catch (error) {
        await record({ kind: 'attach', tabId, ok: false, summary: (error as Error).message });
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_approval_status',
    {
      title: 'Check approval state',
      description: 'Read the approval state of a tab (none, pending, granted, revoked) without starting anything.',
      inputSchema: { tabId: z.number().int() },
    },
    async ({ tabId }) => {
      try {
        const entry = await bridge.request<{ state: ApprovalState; reason: string; requestId: string } | null>(
          'ext.approvalStatus',
          { tabId },
        );
        return ok(entry ?? { state: 'none' });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'wasmcheat_detach',
    {
      title: 'Detach from a tab',
      description: 'Revoke approval for a tab. The agent stops being able to read or write that tab immediately.',
      inputSchema: { tabId: z.number().int(), reason: z.string().optional() },
    },
    async ({ tabId, reason }) => {
      try {
        await bridge.request('ext.detach', { tabId, reason });
        await record({ kind: 'detach', tabId, ok: true, summary: reason ?? 'detached' });
        return ok({ tabId, approval: 'revoked' });
      } catch (error) {
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
        'Only function exports can be hooked.',
      inputSchema: { tabId: z.number().int() },
    },
    async ({ tabId }) => {
      try {
        return ok(await page<InstanceInfo[]>(tabId, 'page.listInstances'));
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
      inputSchema: { tabId: z.number().int() },
    },
    async ({ tabId }) => {
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
        'after the value moves in the app. Returns a scanId and a match count; use wasmcheat_scan_results to read hits.',
      inputSchema: {
        tabId: z.number().int(),
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
      },
    },
    async ({ tabId, instanceId, type, mode, value, value2, tolerance, alignment, maxResults, scanId }) => {
      try {
        const parsedValue = numeric(value);
        const parsedValue2 = numeric(value2);
        const effectiveMode = mode ?? (parsedValue === undefined ? 'changed' : 'exact');
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
            });

        if (!scanId) {
          await record({
            kind: 'scan',
            tabId,
            ok: true,
            summary: `scan ${summary.scanId} ${effectiveMode} ${type}${parsedValue === undefined ? '' : ` = ${parsedValue}`}`,
            detail: { instanceId, matchCount: summary.matchCount, truncated: summary.truncated },
          });
        }

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
        tabId: z.number().int(),
        instanceId: z.string().describe('Instance id from wasmcheat_list_instances, e.g. "w1".'),
        text: z.string().min(1).describe('Text to find, or a hex string when encoding is "bytes".'),
        encoding: z.enum(['ascii', 'utf8', 'bytes']).optional().describe('How to encode the needle (default "ascii").'),
        caseSensitive: z.boolean().optional().describe('Default true; set false to fold ASCII case.'),
        from: z.number().int().min(0).optional().describe('Start offset in bytes (default 0).'),
        to: z.number().int().min(0).optional().describe('End offset in bytes (default end of memory).'),
        maxResults: z.number().int().min(1).max(250_000).optional(),
      },
    },
    async ({ tabId, instanceId, text, encoding, caseSensitive, from, to, maxResults }) => {
      try {
        const result = await page<TextScanResult>(tabId, 'page.scan.text', {
          instanceId,
          text,
          encoding,
          caseSensitive,
          range: from === undefined && to === undefined ? undefined : { start: from ?? 0, end: to ?? Number.MAX_SAFE_INTEGER },
          maxResults,
        });
        await record({
          kind: 'scan',
          tabId,
          ok: true,
          summary: `text scan ${encoding ?? 'ascii'} "${text}" -> ${result.total} match(es)`,
          detail: { instanceId },
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
      description: 'Page through the hits of a scan (current memory values, not the snapshot).',
      inputSchema: {
        tabId: z.number().int(),
        scanId: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ tabId, scanId, offset, limit }) => {
      try {
        const result = await page<{ hits: { address: Address; value: number }[]; total: number }>(
          tabId,
          'page.scan.results',
          { scanId, offset, limit },
        );
        return ok({
          ...result,
          hits: result.hits.map((hit) => ({ address: formatAddress(hit.address), value: hit.value })),
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
      inputSchema: { tabId: z.number().int(), scanId: z.string() },
    },
    async ({ tabId, scanId }) => {
      try {
        return ok({ dropped: await page<boolean>(tabId, 'page.scan.drop', { scanId }) });
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
        tabId: z.number().int(),
        address: ADDRESS,
        type: VALUE_TYPE.optional().describe('Value width (required unless you pass length).'),
        count: z.number().int().min(1).max(1024).optional(),
        length: z.number().int().min(1).max(4096).optional().describe('Read this many raw bytes instead of values.'),
      },
    },
    async ({ tabId, address, type, count, length }) => {
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
        tabId: z.number().int(),
        address: ADDRESS,
        type: VALUE_TYPE,
        value: z
          .union([z.number(), z.string()])
          .describe('New value. Integers are wrapped to the type width; floats are stored as the nearest f32/f64.'),
      },
    },
    async ({ tabId, address, type, value }) => {
      const parsed = numeric(value);
      if (parsed === undefined) return fail(new BridgeError('BAD_PARAMS', 'value is required'));
      try {
        const target = addr(address);
        const result = await page<WriteResult>(tabId, 'page.write', { address: target, type, value: parsed });
        await record({
          kind: 'write',
          tabId,
          ok: true,
          summary: `write ${formatAddress(target)} ${type} ${result.before} -> ${result.after}`,
          detail: { requested: parsed },
        });
        return ok({ ...result, address });
      } catch (error) {
        await record({ kind: 'write', tabId, ok: false, summary: `write failed: ${(error as Error).message}` });
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
        tabId: z.number().int(),
        action: z.enum(['set', 'clear', 'list']),
        address: ADDRESS.optional(),
        type: VALUE_TYPE.optional(),
        value: z.union([z.number(), z.string()]).optional(),
        freezeId: z.string().optional(),
      },
    },
    async ({ tabId, action, address, type, value, freezeId }) => {
      try {
        if (action === 'list') return ok(await page<FreezeEntry[]>(tabId, 'page.freeze.list'));
        if (action === 'clear') {
          if (!freezeId) return fail(new BridgeError('BAD_PARAMS', 'freezeId is required for clear'));
          const cleared = await page<boolean>(tabId, 'page.freeze.clear', { freezeId });
          await record({ kind: 'freeze', tabId, ok: true, summary: `freeze cleared ${freezeId}` });
          return ok({ cleared });
        }
        if (!address || !type) return fail(new BridgeError('BAD_PARAMS', 'address and type are required for set'));
        const target = addr(address);
        const parsed = numeric(value) ?? 0;
        const entry = await page<FreezeEntry>(tabId, 'page.freeze.set', { address: target, type, value: parsed });
        await record({
          kind: 'freeze',
          tabId,
          ok: true,
          summary: `freeze ${formatAddress(target)} ${type} = ${parsed}`,
          detail: { freezeId: entry.id },
        });
        return ok(entry);
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
        tabId: z.number().int(),
        action: z.enum(['add', 'remove', 'list', 'poll']),
        address: ADDRESS.optional(),
        type: VALUE_TYPE.optional(),
        watchId: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ tabId, action, address, type, watchId, limit }) => {
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

  server.registerTool(
    'wasmcheat_find_writes',
    {
      title: 'Find what writes to an address',
      description:
        'Answers "which function writes here?" — Cheat Engine\'s write breakpoint, for wasm. WebAssembly has no write events, ' +
        'so the tab is reloaded with an instrumented module: every store then calls back with the function index that made it. ' +
        'The reload keeps the existing approval. Returns every hit with the function that wrote and the value before/after.',
      inputSchema: {
        tabId: z.number().int(),
        address: ADDRESS,
        type: VALUE_TYPE.optional(),
        maxHits: z.number().int().min(1).max(500).optional(),
        timeoutSeconds: z.number().int().min(1).max(120).optional(),
        reload: z.boolean().optional(),
      },
    },
    async ({ tabId, address, type, maxHits, timeoutSeconds, reload }) => {
      try {
        const target = addr(address);
        const formatted = formatAddress(target);
        const wait = (timeoutSeconds ?? 15) * 1000;
        await bridge.request('ext.traceArm', {
          tabId,
          address: formatted,
          ...(type ? { type } : {}),
          ...(maxHits ? { maxHits } : {}),
        });
        if (reload !== false) {
          await bridge.request('ext.reload', { tabId }, 60_000);
        }
        const deadline = Date.now() + wait;
        let status = await page<WriteTraceStatus>(tabId, 'page.trace.status');
        while (status.hits.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          status = await page<WriteTraceStatus>(tabId, 'page.trace.status');
        }
        record({
          kind: 'trace',
          tabId,
          ok: true,
          summary: `watched writes to ${formatted} (${status.hits.length} hit(s))`,
          detail: { hits: status.hits, installed: status.installed },
        });
        const writers = new Map<string, { funcIndex: number; funcName?: string; hits: number; last: unknown }>();
        for (const hit of status.hits) {
          const key = hit.funcName ?? `wasm-function[${hit.funcIndex}]`;
          const entry = writers.get(key);
          if (entry) entry.hits += 1;
          else writers.set(key, { funcIndex: hit.funcIndex, funcName: hit.funcName, hits: 1, last: hit.value });
        }
        const note = status.installed
          ? status.hits.length > 0
            ? `${writers.size} function(s) wrote ${formatted}`
            : `no writes to ${formatted} were seen in ${(wait / 1000).toFixed(0)}s — the page may not touch it until you interact with it`
          : `the watchpoint never installed${status.note ? `: ${status.note}` : ''}`;
        return ok({ ...status, writers: [...writers.entries()].map(([name, entry]) => ({ name, ...entry })) }, note);
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
        'Low-level control for find_writes. arm (needs tabId + address) installs the watchpoint for the next instantiation and ' +
        'remembers it across a reload, status reports whether it installed, poll drains the collected hits, clear resets them, ' +
        'stop removes the watchpoint entirely.',
      inputSchema: {
        tabId: z.number().int(),
        action: z.enum(['arm', 'status', 'poll', 'clear', 'stop']),
        address: ADDRESS.optional(),
        type: VALUE_TYPE.optional(),
        maxHits: z.number().int().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ tabId, action, address, type, maxHits, limit }) => {
      try {
        if (action === 'arm') {
          if (!address) return fail(new BridgeError('BAD_PARAMS', 'address is required for arm'));
          const status = await bridge.request<WriteTraceStatus>('ext.traceArm', {
            tabId,
            address: formatAddress(addr(address)),
            ...(type ? { type } : {}),
            ...(maxHits ? { maxHits } : {}),
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
        'Import hooks apply to the *next* instantiation of a module importing that name ("env.log") — WebAssembly binds imports ' +
        'at instantiation, so an already-running instance cannot be re-patched (the response says pending: true).\n' +
        'Every add/remove is audited. If the page forbids eval, pass `fallback` for a declarative behaviour.',
      inputSchema: {
        tabId: z.number().int(),
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
    async ({ tabId, action, instanceId, target, name, body, fallback, note, hookId, enabled }) => {
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
          await record({ kind: 'hook', tabId, ok: true, summary: `hook removed ${hookId}` });
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
        await record({
          kind: 'hook',
          tabId,
          ok: true,
          summary: `hook ${target} ${name} on ${instanceId}`,
          detail: { body, note, pending: entry.pending },
        });
        return ok(
          entry,
          entry.target === 'import' && entry.pending
            ? 'Registered, but pending: imports bind at instantiation, so this applies the next time the page instantiates a module importing it.'
            : undefined,
        );
      } catch (error) {
        await record({ kind: 'hook', tabId, ok: false, summary: `hook failed: ${(error as Error).message}` });
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
