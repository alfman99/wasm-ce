import { expect, test, type Page } from '@playwright/test';
import { buildStoreModule } from '../helpers/wasm-builder';
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
  host?: string;
  workerId?: string;
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
let workerPage: Page;
let workerTabId: number;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await assertPortFree(BRIDGE_PORT);
  demo = await startDemoServer();
  browser = await launchBrowser();
  // The extension defaults to 7331; this run uses its own port so the human's browser cannot join.
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
  await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), BRIDGE_PORT);
  mcp = await connectMcp();
  await waitForBridge(mcp);

  game = await browser.context.newPage();
  await game.goto(DEMO_URL);
  await game.waitForFunction(() => Boolean((window as unknown as { __foundry?: unknown }).__foundry), null, {
    timeout: 30_000,
  });
});

test.afterAll(async () => {
  // Teardown that hangs must not be reported as a failing test: cap the whole thing.
  const teardown = (async () => {
    await mcp?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await demo?.stop();
  })();
  await Promise.race([teardown, sleep(20_000)]);
});

test('a tab is visible but unusable before the human approves it', async () => {
  // The service worker may still be reconnecting when the suite starts, so wait for the tab
  // instead of racing the first list.
  await expect
    .poll(
      async () => {
        const listed = await call<{ url: string }[]>(mcp, 'wasmcheat_list_tabs');
        return listed.data.filter((entry) => entry.url.startsWith(DEMO_URL)).length;
      },
      { timeout: 20_000, message: 'the demo tab never appeared in list_tabs' },
    )
    .toBeGreaterThan(0);
  const tabs = await call<{ tabId: number; url: string; approval: string; agentAttached: boolean }[]>(
    mcp,
    'wasmcheat_list_tabs',
  );
  expect(tabs.isError, tabs.text).toBe(false);
  const tab = tabs.data.find((entry) => entry.url.startsWith(DEMO_URL));
  expect(tab, `the demo tab should be listed: ${JSON.stringify(tabs.data)} | ${tabs.text}`).toBeTruthy();
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

test('every mutation is in the audit log, whoever made it', async () => {
  // This test performs one mutation of every kind first, so the assertions are causal rather than
  // a guess about what earlier tests happened to leave behind.
  const scan = await call<{ scanId: string }>(mcp, 'wasmcheat_scan', {
    tabId,
    instanceId,
    type: 'i32',
    mode: 'exact',
    value: 123456,
  });
  expect(scan.isError, scan.text).toBe(false);
  const narrowed = await call(mcp, 'wasmcheat_scan', {
    tabId,
    instanceId,
    type: 'i32',
    scanId: scan.data.scanId,
    mode: 'unchanged',
  });
  expect(narrowed.isError, narrowed.text).toBe(false);
  const dropped = await call(mcp, 'wasmcheat_scan_drop', { tabId, scanId: scan.data.scanId });
  expect(dropped.isError, dropped.text).toBe(false);

  const hook = await call<{ id: string }>(mcp, 'wasmcheat_hook', {
    tabId,
    action: 'add',
    instanceId,
    target: 'export',
    name: 'get_score',
    body: 'return 1;',
  });
  expect(hook.isError, hook.text).toBe(false);
  for (const enabled of [false, true]) {
    const step = await call(mcp, 'wasmcheat_hook', { tabId, action: 'enable', hookId: hook.data.id, enabled });
    expect(step.isError, step.text).toBe(false);
  }
  const removed = await call(mcp, 'wasmcheat_hook', { tabId, action: 'remove', hookId: hook.data.id });
  expect(removed.isError, removed.text).toBe(false);

  const watch = await call<{ id: string }>(mcp, 'wasmcheat_watch', {
    tabId,
    action: 'add',
    address: 'w1:0x408',
    type: 'i32',
  });
  expect(watch.isError, watch.text).toBe(false);
  const unwatched = await call(mcp, 'wasmcheat_watch', { tabId, action: 'remove', watchId: watch.data.id });
  expect(unwatched.isError, unwatched.text).toBe(false);

  const patch = await call<{ patch: { id: string } }>(mcp, 'wasmcheat_patch', {
    tabId,
    action: 'add',
    target: 'get_score',
    mode: 'stub',
    value: 4242,
    reload: false,
  });
  expect(patch.isError, patch.text).toBe(false);
  const unpatched = await call(mcp, 'wasmcheat_patch', {
    tabId,
    action: 'remove',
    patchId: patch.data.patch.id,
    reload: false,
  });
  expect(unpatched.isError, unpatched.text).toBe(false);

  const entries = await call<{ kind: string; summary: string; ok: boolean; tabId?: number }[]>(mcp, 'wasmcheat_audit', {
    limit: 200,
  });
  expect(entries.isError, entries.text).toBe(false);
  const kinds = new Set(entries.data.map((entry) => entry.kind));
  for (const kind of ['write', 'freeze', 'hook', 'scan', 'watch', 'patch', 'attach']) {
    expect([...kinds], `audit kinds: ${[...kinds].join(', ')}`).toContain(kind);
  }
  // Attribution: every line that names a mutation also names the tab it happened on.
  const mutations = entries.data.filter((entry) => entry.kind !== 'trace' && entry.kind !== 'approval');
  expect(mutations.length, 'audit should have lines').toBeGreaterThan(0);
  expect(mutations.every((entry) => typeof entry.tabId === 'number')).toBe(true);
  expect(entries.data.some((entry) => entry.summary.includes('w1:0x408'))).toBe(true);
  // Writes are now reported by the extension, failures included, so assert the successful ones
  // rather than "no failures": a refused write is exactly what a log is for.
  expect(
    entries.data.some((entry) => entry.kind === 'write' && entry.ok && entry.summary.includes('w1:0x408')),
  ).toBe(true);
  // A hook toggle is a real change of behaviour, so both directions are recorded with its id.
  const hookLines = entries.data.filter((entry) => entry.kind === 'hook');
  expect(hookLines.some((entry) => entry.summary.includes('disabled'))).toBe(true);
  expect(hookLines.some((entry) => entry.summary.includes('enabled'))).toBe(true);
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

  // The instrumented module behaves exactly like the original one. The game keeps scoring while
  // the test runs, so the score is a floor rather than an exact number.
  const painted = Number(await game.locator('#score').textContent());
  expect(painted).toBeGreaterThanOrEqual(25);
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
  // The game keeps scoring while the test runs, so only the floor is fixed.
  expect((await snapshot(game)).score).toBeGreaterThanOrEqual(25);
});

test('a patched function body changes what the wasm itself returns', async () => {
  // A stub lives in the binary, so unlike a hook it also reaches callers that cached the export
  // and code that never was an export at all. Installing it costs exactly one reload.
  const patched = call<{ patch: { id: string; applied: boolean }; patches: unknown[] }>(mcp, 'wasmcheat_patch', {
    tabId,
    action: 'add',
    target: 'get_score',
    mode: 'stub',
    value: 777,
    note: 'e2e',
  });
  await game.waitForLoadState('load');
  await expect(game.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });
  const result = await patched;
  if (result.isError) throw new Error(`patch failed: ${result.text}`);
  expect(result.isError, result.text).toBe(false);
  expect(result.data.patch.applied, result.text).toBe(true);
  // The page paints score from get_score() every frame; the stub owns the answer now.
  await expect(game.locator('#score')).toHaveText('777');
  // A neighbour in the same module keeps working, so the patch did not damage the instance.
  await expect(game.locator('#lives')).toHaveText('5');

  const list = await call<{ target: string; applied: boolean; funcIndex?: number }[]>(mcp, 'wasmcheat_patch', {
    tabId,
    action: 'list',
  });
  expect(list.isError, list.text).toBe(false);
  expect(list.data.map((entry) => entry.target)).toEqual(['get_score']);
  expect(typeof list.data[0]?.funcIndex, list.text).toBe('number');

  const removed = await call(mcp, 'wasmcheat_patch', { tabId, action: 'remove', patchId: result.data.patch.id });
  expect(removed.isError, removed.text).toBe(false);
  await game.waitForLoadState('load');
  await expect(game.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });
  // The original function is back: the stub value is gone from the page.
  await expect(game.locator('#score')).not.toHaveText('777');
});

test('a pointer chain found by scanning is resolved back to the score address', async () => {
  // Park a pointer to the score in unused memory so the chain is unambiguous.
  await call(mcp, 'wasmcheat_write', { tabId, address: 'w1:0x600', type: 'u32', value: 0x408 });
  const scan = await call<{ chains: { base: string; offsets: number[]; read: string }[] }>(mcp, 'wasmcheat_pointer_scan', {
    tabId,
    address: 'w1:0x408',
    maxDepth: 1,
    maxOffset: 0x10,
  });
  expect(scan.isError, scan.text).toBe(false);
  const chain = scan.data.chains.find((entry) => entry.base === 'w1:0x600');
  expect(chain, `no chain from w1:0x600: ${scan.text}`).toBeTruthy();
  expect(chain!.offsets).toEqual([0]);

  const resolved = await call<{ final: string; value: number }>(mcp, 'wasmcheat_pointer_resolve', {
    tabId,
    base: 'w1:0x600',
    offsets: [0],
  });
  expect(resolved.isError, resolved.text).toBe(false);
  expect(resolved.data.final).toBe('w1:0x408');
  const score = await call<{ values: number[] }>(mcp, 'wasmcheat_read', { tabId, address: 'w1:0x408', type: 'i32' });
  expect(resolved.data.value).toBe(score.data.values[0]);
});

test('a worker the page creates is visible, drivable, and reported when it dies', async () => {
  // The page agent replaces `Worker` on its first ping (document_start), so a worker created now
  // boots through the blob bootstrap: worker agent first, this script second.
  const storeModule = Array.from(buildStoreModule());
  await game.evaluate((bytes) => {
    const source = `
      WebAssembly.instantiate(new Uint8Array(${JSON.stringify(bytes)}), {}).then((result) => {
        result.instance.exports.tick();
        self.postMessage({ e2e: 'wasm ready' });
      });
      self.onmessage = () => {};
    `;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    (window as unknown as { __wasmcheatE2eWorker?: Worker }).__wasmcheatE2eWorker = worker;
    // Returning the Worker here would make evaluate try to serialise it and never resolve.
    return true;
  }, storeModule);

  await expect
    .poll(
      async () => {
        const listed = await call<InstanceInfo[]>(mcp, 'wasmcheat_list_instances', { tabId });
        return listed.data.filter((entry) => entry.host === 'worker' && entry.workerId === 'k1').length;
      },
      { timeout: 20_000, message: 'the worker instance never appeared in list_instances' },
    )
    .toBe(1);

  const workers = await call<{ id: string; url: string; type: string; instances: number }[]>(
    mcp,
    'wasmcheat_list_workers',
    { tabId },
  );
  expect(workers.isError, workers.text).toBe(false);
  const engine = workers.data.find((entry) => entry.id === 'k1');
  expect(engine, workers.text).toBeTruthy();
  expect(engine).toMatchObject({ id: 'k1', type: 'classic', instances: 1 });
  expect(engine!.url.startsWith('blob:')).toBe(true);

  // The page's own instances are still listed, and every call for a k1-… id is forwarded.
  const listed = await call<InstanceInfo[]>(mcp, 'wasmcheat_list_instances', { tabId });
  expect(listed.data.some((entry) => entry.id === 'w1')).toBe(true);
  const read = await call<{ values: number[] }>(mcp, 'wasmcheat_read', { tabId, address: 'k1-1:0x20', type: 'i32' });
  expect(read.isError, read.text).toBe(false);
  expect(read.data.values).toEqual([2]);

  const scan = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId,
    instanceId: 'k1-1',
    type: 'i32',
    mode: 'exact',
    value: 2,
  });
  expect(scan.isError, scan.text).toBe(false);
  expect(scan.data.scanId).toBe('k1-s1');
  expect(scan.data.matchCount).toBe(1);
  expect(scan.data.sample[0]!.address).toBe('k1-1:0x20');

  // Terminating the worker must not hang a call: it names the dead worker instead.
  await game.evaluate(() => (window as unknown as { __wasmcheatE2eWorker?: Worker }).__wasmcheatE2eWorker?.terminate());
  const gone = await call(mcp, 'wasmcheat_read', { tabId, address: 'k1-1:0x20', type: 'i32' });
  expect(gone.isError).toBe(true);
  expect(gone.text).toContain('NO_INSTANCE');
  expect(gone.text).toContain('k1');
  const afterDeath = await call<InstanceInfo[]>(mcp, 'wasmcheat_list_instances', { tabId });
  expect(afterDeath.data.some((entry) => entry.id === 'k1-1')).toBe(false);
  const noWorkers = await call<unknown[]>(mcp, 'wasmcheat_list_workers', { tabId });
  expect(noWorkers.data).toEqual([]);
});

test('detaching revokes access immediately', async () => {
  await call(mcp, 'wasmcheat_detach', { tabId, reason: 'e2e teardown' });
  const read = await call(mcp, 'wasmcheat_read', { tabId, address: 'w1:0x408', type: 'i32' });
  expect(read.isError).toBe(true);
  expect(read.text).toContain('NEED_APPROVAL');
});

// Known flake, tracked: since the bridge port moved into chrome.storage this fails in under a
// second and leaves afterAll hanging, which looks like the approve step racing the port switch
// rather than a scanner bug. The subframe routing it covers is also exercised by the live Brave
// run against a YouTube Playable (see README).
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
  // The iframe's game keeps ticking (its own rAF loop owns the value), so this asserts the write
  // landed rather than that the digit freezes: before the write the score was in single digits.
  await expect
    .poll(async () => Number(await inner.locator('#score').textContent()), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(777);

  const read = await call<{ values: number[] }>(mcp, 'wasmcheat_read', {
    tabId: framedTabId,
    address: 'w1:0x408',
    type: 'i32',
  });
  expect(read.data.values[0]).toBeGreaterThanOrEqual(777);

  await call(mcp, 'wasmcheat_detach', { tabId: framedTabId, reason: 'e2e framed teardown' });
});

// A human at the keyboard, with no agent in the loop: the DevTools panel is a first-class panel,
// not a popup, and it talks to the same dispatcher the MCP bridge uses.
test('the DevTools panel drives the tab without an agent', async () => {
  // Test 14 revoked this tab, so this test also proves the panel cannot skip the gate.
  await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());

  const panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);

  // The panel finds its target by listing tabs: the inspected tab is a click, not a hidden channel.
  const row = panel.locator(`li.tab[data-tab-id="${tabId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(row).toHaveClass(/is-target/);

  const rawMethod = panel.locator('#raw-method');
  const rawParams = panel.locator('#raw-params');
  const rawOut = panel.locator('#raw-out');

  // An unapproved tab is refused exactly as it is for an agent: same code, same message.
  await rawMethod.fill('page.read');
  await rawParams.fill('{"address":"w1:0x408","type":"i32"}');
  await panel.locator('#raw-send').click();
  await expect(rawOut).toContainText('NEED_APPROVAL');

  // The panel asks and the human answers *in the panel*: the request registers as pending, the click
  // emits approval.resolved, and the waiting attach proceeds on that event rather than a poll.
  const attaching = panel.evaluate(() => {
    const hooks = (window as unknown as { __panel: { attach: (tabId?: number) => Promise<unknown> } }).__panel;
    return hooks.attach();
  });
  await expect(panel.locator('#approval')).toContainText('pending');
  await panel.locator('#approve').click();
  expect(JSON.stringify(await attaching)).toContain('granted');
  await expect(panel.locator('#approval')).toContainText('granted');

  // Write then read the score through the raw console; the DOM is the only thing asserted, so the
  // panel has to be showing what linear memory actually holds.
  await rawMethod.fill('page.write');
  await rawParams.fill('{"address":"w1:0x408","type":"i32","value":987654}');
  await panel.locator('#raw-send').click();
  await expect(rawOut).toContainText('"after": 987654');

  await rawMethod.fill('page.read');
  await rawParams.fill('{"address":"w1:0x408","type":"i32"}');
  await panel.locator('#raw-send').click();
  await expect(rawOut).toContainText('987654');

  // A typed form reads the same value: the console and the forms share one dispatcher.
  await panel.locator('#mem-address').fill('w1:0x408');
  await panel.locator('#mem-read').click();
  await expect(panel.locator('#memory-out')).toContainText('987654');

  // The live log comes from the worker's port, which just carried this approval.
  await expect(panel.locator('#event-log')).toContainText('approval');

  await panel.close();
});

test('a saved scan survives a reload and keeps narrowing', async () => {
  await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());
  await game.click('#reset');
  for (let i = 0; i < 4; i++) await game.click('#mine');
  const before = await snapshot(game);
  expect(before.score).toBe(100);

  const scan = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId,
    instanceId,
    type: 'i32',
    mode: 'exact',
    value: before.score,
  });
  expect(scan.isError, scan.text).toBe(false);

  const saved = await call<{ name: string; matchCount: number }>(mcp, 'wasmcheat_saved', {
    tabId,
    action: 'save',
    name: 'score candidates',
    scanId: scan.data.scanId,
  });
  expect(saved.isError, saved.text).toBe(false);
  expect(saved.data.name).toBe('score candidates');
  expect(saved.data.matchCount).toBe(scan.data.matchCount);

  // A reload is exactly what kills an in-memory session: the list has to come back from the page's
  // own storage, not from anything the MCP server kept.
  const reloaded = await call(mcp, 'wasmcheat_attach', { tabId, reload: true, waitSeconds: 30 });
  expect(reloaded.isError, reloaded.text).toBe(false);
  await expect(game.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });
  await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());

  const listed = await call<{ name: string; matchCount: number }[]>(mcp, 'wasmcheat_saved', { tabId, action: 'list' });
  expect(listed.isError, listed.text).toBe(false);
  expect(listed.data.map((item) => item.name)).toContain('score candidates');

  const opened = await call<{ scanId: string; matchCount: number; instanceId: string }>(mcp, 'wasmcheat_saved', {
    tabId,
    action: 'open',
    name: 'score candidates',
  });
  expect(opened.isError, opened.text).toBe(false);
  expect(opened.data.matchCount).toBe(saved.data.matchCount);

  // The reload rebuilt the heap, so put the demo back in the same state before narrowing.
  await game.click('#reset');
  for (let i = 0; i < 4; i++) await game.click('#mine');
  expect((await snapshot(game)).score).toBe(100);

  // The re-opened list must still be a working session: change the score and narrow by `changed`.
  await game.click('#mine');
  const after = await snapshot(game);
  expect(after.score).toBe(125);
  const narrowed = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId,
    instanceId: opened.data.instanceId,
    scanId: opened.data.scanId,
    type: 'i32',
    mode: 'changed',
  });
  expect(narrowed.isError, narrowed.text).toBe(false);
  const hits = await call<{ hits: { address: string }[] }>(mcp, 'wasmcheat_scan_results', {
    tabId,
    scanId: opened.data.scanId,
    limit: 20,
  });
  expect(hits.isError, hits.text).toBe(false);
  expect(hits.data.hits.map((hit) => hit.address)).toContain('w1:0x408');

  const deleted = await call<{ deleted: boolean }>(mcp, 'wasmcheat_saved', {
    tabId,
    action: 'delete',
    name: 'score candidates',
  });
  expect(deleted.isError, deleted.text).toBe(false);
  expect(deleted.data.deleted).toBe(true);
  const empty = await call<{ name: string }[]>(mcp, 'wasmcheat_saved', { tabId, action: 'list' });
  expect(empty.data.map((item) => item.name)).not.toContain('score candidates');
});

test('wasm instantiated inside a Web Worker is discovered and driven', async () => {
  // Unity, Godot 4 and most itch.io builds instantiate their module in a worker, where the page
  // realm's WebAssembly hook never sees it. The demo runs the same game that way.
  workerPage = await browser.context.newPage();
  await workerPage.goto(`${DEMO_URL}worker.html`);
  await expect(workerPage.locator('#status')).toContainText('wasm ready', { timeout: 30_000 });

  const tabs = await call<{ tabId: number; url: string }[]>(mcp, 'wasmcheat_list_tabs');
  const host = tabs.data.find((tab) => tab.url.endsWith('/worker.html'));
  expect(host, tabs.text).toBeDefined();
  workerTabId = host!.tabId;

  const pending = call(mcp, 'wasmcheat_attach', {
    tabId: workerTabId,
    reason: 'e2e: wasm inside a worker',
    waitSeconds: 60,
  });
  await approveThroughPopup(browser, workerTabId);
  const attached = await pending;
  expect(attached.isError, attached.text).toBe(false);

  const workers = await call<{ id: string; url: string; instances: number }[]>(mcp, 'wasmcheat_list_workers', {
    tabId: workerTabId,
  });
  expect(workers.isError, workers.text).toBe(false);
  expect(workers.data.length, workers.text).toBeGreaterThanOrEqual(1);
  expect(workers.data.some((worker) => worker.instances > 0)).toBe(true);

  const instances = await call<InstanceInfo[]>(mcp, 'wasmcheat_list_instances', { tabId: workerTabId });
  expect(instances.isError, instances.text).toBe(false);
  const inWorker = instances.data.find((instance) => instance.host === 'worker');
  expect(inWorker, instances.text).toBeDefined();
  expect(inWorker!.workerId).toBeTruthy();

  // A worker instance id is namespaced by the worker that owns it, so nothing else needs to know
  // which realm the memory lives in.
  // Ore is the stable counter: the score ticks on its own, so a write to it proves nothing.
  const coinsAddress = `${inWorker!.id}:0x40c`;
  await workerPage.click('#mine');
  await expect.poll(async () => Number(await workerPage.locator('#coins').textContent()), { timeout: 20_000 }).toBe(1);

  const before = await call<{ values: number[] }>(mcp, 'wasmcheat_read', { tabId: workerTabId, address: coinsAddress, type: 'i32' });
  expect(before.isError, before.text).toBe(false);
  expect(before.data.values[0]).toBe(1);

  const written = await call(mcp, 'wasmcheat_write', { tabId: workerTabId, address: coinsAddress, type: 'i32', value: 31337 });
  expect(written.isError, written.text).toBe(false);

  // The worker republishes its state after every tick, so the number on screen is proof the write
  // reached the worker's memory and not just a page-realm copy.
  await expect.poll(async () => Number(await workerPage.locator('#coins').textContent()), { timeout: 20_000 }).toBe(31337);

  const scan = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId: workerTabId,
    instanceId: inWorker!.id,
    type: 'i32',
    mode: 'exact',
    value: 31337,
  });
  expect(scan.isError, scan.text).toBe(false);
  expect(scan.data.scanId).toMatch(/^k\d+-s\d+$/);

  // Narrowing keeps the ore address and drops everything else, which is the whole point of a scan.
  const narrowed = await call<ScanSummary>(mcp, 'wasmcheat_scan', {
    tabId: workerTabId,
    instanceId: inWorker!.id,
    type: 'i32',
    mode: 'unchanged',
    scanId: scan.data.scanId,
  });
  expect(narrowed.isError, narrowed.text).toBe(false);
  const results = await call<{ hits: { address: string }[]; total: number }>(mcp, 'wasmcheat_scan_results', {
    tabId: workerTabId,
    scanId: narrowed.data.scanId,
  });
  expect(results.isError, results.text).toBe(false);
  expect(results.data.hits.map((hit) => hit.address)).toContain(coinsAddress);

  await call(mcp, 'wasmcheat_detach', { tabId: workerTabId, reason: 'e2e worker teardown' });
});
