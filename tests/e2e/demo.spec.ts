import { expect, test, type Page } from '@playwright/test';
import {
  BRIDGE_PORT,
  DEMO_URL,
  approveThroughPopup,
  assertPortFree,
  call,
  connectMcp,
  launchBrowser,
  sleep,
  startDemoServer,
  waitForBridge,
  type DemoServer,
  type LaunchedBrowser,
  type Mcp,
} from './harness.js';

/**
 * The demo the README promises, run for real: a human approves a tab in the popup, an agent
 * scans and narrows to the score in linear memory, writes it, freezes lives, patches a wasm
 * export, and everything it did shows up in the audit log.
 */

interface InstanceInfo {
  id: string;
  moduleHash: string;
  memory: { byteLength: number } | null;
  exports: { name: string; kind: string }[];
  importPatchability: string;
}

interface ScanSummary {
  scanId: string;
  matchCount: number;
  truncated: boolean;
  sample: { address: string; value: number }[];
}

interface HookEntry {
  id: string;
  name: string;
  target: string;
  enabled: boolean;
  pending: boolean;
}

let demo: DemoServer;
let browser: LaunchedBrowser;
let mcp: Mcp;
let game: Page;
let tabId: number;
let instanceId: string;

async function snapshot(page: Page): Promise<{ score: number; coins: number; lives: number }> {
  return page.evaluate(() => {
    const foundry = (window as unknown as { __foundry: { snapshot: () => { score: number; coins: number; lives: number } } })
      .__foundry;
    return foundry.snapshot();
  });
}

/** A second page that hosts the demo inside a cross-origin iframe (localhost vs 127.0.0.1). */
let framed: Page;
let framedTabId: number;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await assertPortFree(BRIDGE_PORT);
  demo = await startDemoServer();
  browser = await launchBrowser();
  mcp = await connectMcp();
  await waitForBridge(mcp);

  game = await browser.context.newPage();
  await game.goto(DEMO_URL);
  await game.waitForFunction(() => Boolean((window as unknown as { __foundry?: unknown }).__foundry), null, {
    timeout: 30_000,
  });
});

test.afterAll(async () => {
  await mcp?.close();
  await browser?.close();
  await demo?.stop();
});

test('a tab is visible but unusable before the human approves it', async () => {
  const tabs = await call<{ tabId: number; url: string; approval: string; agentAttached: boolean }[]>(
    mcp,
    'wasmcheat_list_tabs',
  );
  expect(tabs.isError, tabs.text).toBe(false);
  const tab = tabs.data.find((entry) => entry.url.startsWith(DEMO_URL));
  expect(tab, 'the demo tab should be listed').toBeTruthy();
  tabId = tab!.tabId;
  expect(tab!.approval).not.toBe('granted');

  const refused = await call(mcp, 'wasmcheat_attach', { tabId, waitSeconds: 0, reason: 'e2e: expecting refusal' });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain('NEED_APPROVAL');

  // The refusal is the service worker's own gate, not the popup's: memory stays untouched.
  const read = await call(mcp, 'wasmcheat_read', { tabId, address: 'w1:0x408', type: 'i32' });
  expect(read.isError).toBe(true);
  expect(read.text).toContain('NEED_APPROVAL');
});

test('approving in the popup attaches the agent and exposes the wasm instance', async () => {
  // The real sequence: the agent asks, then the human clicks in the popup, then the call resolves.
  const pending = call<{ approval: { state: string }; instances: InstanceInfo[] }>(mcp, 'wasmcheat_attach', {
    tabId,
    waitSeconds: 30,
    reason: 'e2e: find and change the score',
  });
  await approveThroughPopup(browser, tabId);
  const attached = await pending;

  expect(attached.isError, attached.text).toBe(false);
  expect(attached.data.approval.state).toBe('granted');
  expect(attached.data.instances.length).toBeGreaterThan(0);

  const status = await call<{ state: string }>(mcp, 'wasmcheat_approval_status', { tabId });
  expect(status.data.state).toBe('granted');

  const instance = attached.data.instances[0]!;
  instanceId = instance.id;
  expect(instance.exports.map((entry) => entry.name)).toEqual(
    expect.arrayContaining(['memory', 'tick', 'mine', 'get_score', 'get_lives']),
  );
  expect(instance.memory?.byteLength).toBeGreaterThan(0);
  expect(['live', 'next-instantiation', 'none']).toContain(instance.importPatchability);
});

test('scan narrows to the score in linear memory', async () => {
  // Pause the tick so the value under test is not moving while the scan runs.
  await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());
  await game.click('#reset');
  for (let i = 0; i < 3; i++) await game.click('#mine');

  const before = await snapshot(game);
  expect(before.score).toBe(75);
  expect(before.coins).toBe(3);

  const first = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId,
    instanceId,
    type: 'i32',
    mode: 'exact',
    value: before.score,
  });
  expect(first.isError, first.text).toBe(false);
  expect(first.data.matchCount).toBeGreaterThan(0);

  const narrowed = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId,
    scanId: first.data.scanId,
    instanceId,
    type: 'i32',
    mode: 'unchanged',
  });
  expect(narrowed.data.matchCount).toBe(first.data.matchCount);

  // Mutating one candidate in the page must be visible to the next pass: that is proof the
  // scan is reading the live linear memory and not a stale snapshot.
  await game.evaluate(() => (window as unknown as { __foundry: { resume: () => void } }).__foundry.resume());
  await game.click('#mine');
  await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());
  const afterMine = await snapshot(game);
  expect(afterMine.score).toBe(100);

  const changed = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId,
    scanId: first.data.scanId,
    instanceId,
    type: 'i32',
    mode: 'changed',
  });
  const hits = await call<{ hits: { address: string; value: number }[]; total: number }>(
    mcp,
    'wasmcheat_scan_results',
    { tabId, scanId: first.data.scanId, limit: 50 },
  );
  expect(changed.data.matchCount).toBe(hits.data.total);
  expect(hits.data.hits.some((hit) => hit.address === 'w1:0x408')).toBe(true);
  expect(hits.data.hits.every((hit) => hit.value === afterMine.score)).toBe(true);
});

test('writing the score changes the page without a reload', async () => {
  const write = await call<{ before: number; after: number }>(mcp, 'wasmcheat_write', {
    tabId,
    address: 'w1:0x408',
    type: 'i32',
    value: 123456,
  });
  expect(write.isError, write.text).toBe(false);
  expect(write.data.after).toBe(123456);

  await expect.poll(async () => (await snapshot(game)).score).toBe(123456);
  await expect(game.locator('#score')).toHaveText('123456');

  const readBack = await call<{ values: number[] }>(mcp, 'wasmcheat_read', {
    tabId,
    address: 'w1:0x408',
    type: 'i32',
  });
  expect(readBack.data.values).toEqual([123456]);
});

test('freezing lives survives the app trying to change them', async () => {
  const frozen = await call<{ id: string; value: number }>(mcp, 'wasmcheat_freeze', {
    tabId,
    action: 'set',
    address: 'w1:0x400',
    type: 'i32',
    value: 999,
  });
  expect(frozen.isError, frozen.text).toBe(false);

  await game.click('#damage');
  await sleep(400);

  expect((await snapshot(game)).lives).toBe(999);
  await expect(game.locator('#lives')).toHaveText('999');

  const listed = await call<{ id: string }[]>(mcp, 'wasmcheat_freeze', { tabId, action: 'list' });
  expect(listed.data.some((entry) => entry.id === frozen.data.id)).toBe(true);

  const cleared = await call<{ cleared: boolean }>(mcp, 'wasmcheat_freeze', {
    tabId,
    action: 'clear',
    freezeId: frozen.data.id,
  });
  expect(cleared.data.cleared).toBe(true);
});

test('reading memory and watching an address reports changes as they happen', async () => {
  const typed = await call<{ values: number[]; type: string }>(mcp, 'wasmcheat_read', {
    tabId,
    address: 'w1:0x408',
    type: 'i32',
  });
  expect(typed.isError, typed.text).toBe(false);
  expect(Number(typed.data.values[0])).toBe(123456);

  const bytes = await call<{ hex: string }>(mcp, 'wasmcheat_read', { tabId, address: 'w1:0x408', length: 4 });
  expect(bytes.isError, bytes.text).toBe(false);
  expect(bytes.data.hex.toLowerCase()).toBe('40e20100');

  const watched = await call<{ id: string }>(mcp, 'wasmcheat_watch', {
    tabId,
    action: 'add',
    address: 'w1:0x408',
    type: 'i32',
  });
  expect(watched.isError, watched.text).toBe(false);

  const written = await call(mcp, 'wasmcheat_write', { tabId, address: 'w1:0x408', type: 'i32', value: 4242 });
  expect(written.isError, written.text).toBe(false);
  await expect(game.locator('#score')).toHaveText('4242');

  await expect
    .poll(async () => {
      const events = await call<{ address: string; before: number; after: number }[]>(mcp, 'wasmcheat_watch', {
        tabId,
        action: 'poll',
      });
      return events.data.map((event) => `${event.address} ${event.before}->${event.after}`);
    })
    .toContain('w1:0x408 123456->4242');

  const removed = await call<{ removed: boolean }>(mcp, 'wasmcheat_watch', {
    tabId,
    action: 'remove',
    watchId: watched.data.id,
  });
  expect(removed.data.removed).toBe(true);
  expect((await call<unknown[]>(mcp, 'wasmcheat_watch', { tabId, action: 'list' })).data).toHaveLength(0);

  // Leave the score at the value the hook test expects to find.
  await call(mcp, 'wasmcheat_write', { tabId, address: 'w1:0x408', type: 'i32', value: 123456 });
});

test('a hook rewrites a wasm export live, and disabling and removing it restores the app', async () => {
  const hooked = await call<HookEntry>(mcp, 'wasmcheat_hook', {
    tabId,
    action: 'add',
    instanceId,
    target: 'export',
    name: 'get_score',
    body: 'return ctx.call(args) + 1000000;',
    note: 'e2e: prove a live export patch',
  });
  expect(hooked.isError, hooked.text).toBe(false);
  expect(hooked.data.pending).toBe(false);

  // The page paints from get_score every frame, so the patch is observable in the DOM.
  await expect.poll(async () => (await snapshot(game)).score).toBe(1_123_456);
  await expect(game.locator('#score')).toHaveText('1123456');

  const listed = await call<HookEntry[]>(mcp, 'wasmcheat_hook', { tabId, action: 'list' });
  expect(listed.data.map((entry) => entry.id)).toContain(hooked.data.id);

  await call(mcp, 'wasmcheat_hook', { tabId, action: 'enable', hookId: hooked.data.id, enabled: false });
  await expect.poll(async () => (await snapshot(game)).score).toBe(123456);

  await call(mcp, 'wasmcheat_hook', { tabId, action: 'enable', hookId: hooked.data.id, enabled: true });
  await expect.poll(async () => (await snapshot(game)).score).toBe(1_123_456);

  const removed = await call<{ removed: boolean }>(mcp, 'wasmcheat_hook', {
    tabId,
    action: 'remove',
    hookId: hooked.data.id,
  });
  expect(removed.data.removed).toBe(true);
  await expect.poll(async () => (await snapshot(game)).score).toBe(123456);
  expect((await call<HookEntry[]>(mcp, 'wasmcheat_hook', { tabId, action: 'list' })).data).toHaveLength(0);
});

test('every write, freeze and hook is in the audit log', async () => {
  const entries = await call<{ kind: string; summary: string; ok: boolean }[]>(mcp, 'wasmcheat_audit', { limit: 100 });
  expect(entries.isError, entries.text).toBe(false);
  const kinds = new Set(entries.data.map((entry) => entry.kind));
  expect(kinds).toContain('write');
  expect(kinds).toContain('freeze');
  expect(kinds).toContain('hook');
  expect(kinds).toContain('attach');
  expect(entries.data.some((entry) => entry.summary.includes('w1:0x408'))).toBe(true);
  expect(entries.data.filter((entry) => entry.kind === 'write').every((entry) => entry.ok)).toBe(true);
});

test('a write watchpoint names the function that changed the score', async () => {
  // find_writes arms the watchpoint and reloads, so the module is instrumented as it loads.
  const watching = call<{
    installed: boolean;
    hits: { funcName?: string; funcIndex: number; value: number; previous: number }[];
    writers: { name: string; hits: number }[];
  }>(mcp, 'wasmcheat_find_writes', {
    tabId,
    address: 'w1:0x408',
    type: 'i32',
    timeoutSeconds: 25,
  });

  // The reload is ours, so the approval the human already gave still applies.
  await game.waitForLoadState('load');
  await expect(game.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });
  await game.click('#reset');
  await game.click('#mine');

  const result = await watching;
  expect(result.isError, result.text).toBe(false);
  expect(result.data.installed, result.text).toBe(true);
  expect(result.data.hits.length, result.text).toBeGreaterThan(0);
  const mine = result.data.hits.find((hit) => hit.funcName === 'mine');
  expect(mine, `no hit from mine: ${result.text}`).toBeTruthy();
  expect(mine?.value).toBe(25);
  expect(result.data.writers.some((writer) => writer.name === 'mine')).toBe(true);

  // The instrumented module behaves exactly like the original one.
  expect((await snapshot(game)).score).toBe(25);
  await expect(game.locator('#score')).toHaveText('25');
});

test('a read watchpoint names the function that reads the score', async () => {
  // Reads are instrumented the same way writes are, so this also reloads the tab.
  const watching = call<{
    installed: boolean;
    hits: { funcName?: string; funcIndex: number; kind: string; value: number }[];
    functions: { name?: string; hits: number }[];
  }>(mcp, 'wasmcheat_find_reads', {
    tabId,
    address: 'w1:0x408',
    type: 'i32',
    timeoutSeconds: 25,
  });

  await game.waitForLoadState('load');
  await expect(game.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });
  await game.click('#mine');

  const result = await watching;
  expect(result.isError, result.text).toBe(false);
  expect(result.data.installed, result.text).toBe(true);
  expect(result.data.hits.length, result.text).toBeGreaterThan(0);
  expect(result.data.hits[0]?.kind, result.text).toBe('read');
  // get_score() is the export the page calls on every frame to paint the score.
  const reader = result.data.functions.find((entry) => entry.name === 'get_score');
  expect(reader, `no read hit from get_score: ${result.text}`).toBeTruthy();
  expect((await snapshot(game)).score).toBe(25);
});

test('detaching revokes access immediately', async () => {
  await call(mcp, 'wasmcheat_detach', { tabId, reason: 'e2e teardown' });
  const read = await call(mcp, 'wasmcheat_read', { tabId, address: 'w1:0x408', type: 'i32' });
  expect(read.isError).toBe(true);
  expect(read.text).toContain('NEED_APPROVAL');
});

test('a game inside a cross-origin iframe is found and driven', async () => {
  framed = await browser.context.newPage();
  await framed.goto(`${DEMO_URL}framed.html`);

  const inner = framed.frameLocator('#game');
  // Cross-origin: the host page cannot read into the frame, so wait through the frame locator.
  await expect(inner.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });

  const tabs = await call<{ tabId: number; url: string; frames?: { frameId: number; url: string }[] }[]>(
    mcp,
    'wasmcheat_list_tabs',
  );
  const host = tabs.data.find((tab) => tab.url.endsWith('/framed.html'));
  expect(host, tabs.text).toBeDefined();
  framedTabId = host!.tabId;

  // The top frame sees a cross-origin iframe and no wasm of its own; the hint must say so.
  const attached = await call<{ instances: InstanceInfo[]; pageAgent: { frameId?: number; url: string } }>(
    mcp,
    'wasmcheat_attach',
    { tabId: framedTabId, reason: 'e2e: drive a game inside an iframe', waitSeconds: 0 },
  );
  expect(attached.isError, attached.text).toBe(true);
  expect(attached.text).toContain('NEED_APPROVAL');

  const approving = call(mcp, 'wasmcheat_attach', {
    tabId: framedTabId,
    reason: 'e2e: drive a game inside an iframe',
    waitSeconds: 60,
  });
  await approveThroughPopup(browser, framedTabId);
  const done = await approving;
  expect(done.isError, done.text).toBe(false);

  const diagnostics = await call<{ instances: number; iframes: { src: string; crossOrigin: boolean }[] }>(
    mcp,
    'wasmcheat_diagnose',
    { tabId: framedTabId },
  );
  expect(diagnostics.isError, diagnostics.text).toBe(false);
  expect(diagnostics.data.instances).toBe(1);

  const instances = await call<InstanceInfo[]>(mcp, 'wasmcheat_list_instances', { tabId: framedTabId });
  expect(instances.isError, instances.text).toBe(false);
  expect(instances.data).toHaveLength(1);

  // Writes must land in the frame's realm, i.e. the game inside the iframe must react.
  const written = await call(mcp, 'wasmcheat_write', {
    tabId: framedTabId,
    address: 'w1:0x408',
    type: 'i32',
    value: 777,
  });
  expect(written.isError, written.text).toBe(false);
  await expect(inner.locator('#score')).toHaveText('777');

  const read = await call<{ values: number[] }>(mcp, 'wasmcheat_read', {
    tabId: framedTabId,
    address: 'w1:0x408',
    type: 'i32',
  });
  expect(read.data.values[0]).toBe(777);

  await call(mcp, 'wasmcheat_detach', { tabId: framedTabId, reason: 'e2e framed teardown' });
});
