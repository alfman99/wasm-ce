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
  type PageAgentInfo,
  type ReadResult,
  type ScanHit,
  type ScanSummary,
  type TabInfo,
  type ValueType,
  type WatchEntry,
  type WatchEvent,
  type WriteResult,
} from '@wasmcheat/protocol';
import { Bridge } from './bridge.js';
import { record, tail } from './audit.js';

export type ToolResult = CallToolResult;

const VALUE_TYPE = z.enum(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']);
const SCAN_MODE = z.enum(['exact', 'changed', 'unchanged', 'increased', 'decreased']);
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
      },
    },
    async ({ tabId, reason, waitSeconds, reload }) => {
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

        const info = await bridge.request<PageAgentInfo>('ext.ensureAgent', { tabId, reload }, 20_000);
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
        value: z.union([z.number(), z.string()]).optional().describe('Target value for exact scans and for tight narrowing.'),
        tolerance: z.number().min(0).optional().describe('Allowed absolute difference for float scans.'),
        alignment: z
          .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
          .optional()
          .describe('Step between candidate offsets. Defaults to the type width; use 1 to catch unaligned data.'),
        maxResults: z.number().int().min(1).max(250_000).optional(),
        scanId: z.string().optional().describe('Narrow this existing scan instead of starting a new one.'),
      },
    },
    async ({ tabId, instanceId, type, mode, value, tolerance, alignment, maxResults, scanId }) => {
      try {
        const parsedValue = numeric(value);
        const effectiveMode = mode ?? (parsedValue === undefined ? 'changed' : 'exact');
        const summary = scanId
          ? await page<ScanSummary>(tabId, 'page.scan.next', {
              scanId,
              mode: effectiveMode,
              value: parsedValue,
              tolerance,
            })
          : await page<ScanSummary>(tabId, 'page.scan.begin', {
              instanceId,
              type,
              mode: effectiveMode,
              value: parsedValue,
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
