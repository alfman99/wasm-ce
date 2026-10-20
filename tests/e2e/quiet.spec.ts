import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { DEMO_URL, assertPortFree, launchBrowser, sleep, startDemoServer } from './harness.js';
import { buildPatchModule } from '../helpers/wasm-builder.js';

// Nothing listens here: the MCP server is optional, and its absence must not show up as errors.
const DEAD_BRIDGE_PORT = 7397;
const PLAIN_PORT = 4175;

// Most people open the panel without the MCP server. Chrome logs a refused WebSocket as an
// extension error no script can catch, so the service worker probes with a silent fetch first;
// this proves the extensions page and every console stay empty through a normal session.
test('no MCP server: no extension errors, no console errors, and an empty tab says so', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const demo = await startDemoServer();
  const plain = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Plain page</title><link rel="icon" href="data:," /><h1>No wasm here</h1>');
  }).listen(PLAIN_PORT, '127.0.0.1');
  const browser = await launchBrowser();
  const consoleErrors: string[] = [];
  const watch = (page: import('@playwright/test').Page, name: string) => {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  };
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    // chrome.developerPrivate only exists on the extensions page. Chrome records extension errors only
    // in developer mode, and only for an extension loaded after it was turned on, hence the reload.
    const admin = await browser.context.newPage();
    await admin.goto('chrome://extensions');
    await admin.evaluate(async (id) => {
      const dev = (chrome as unknown as {
        developerPrivate: {
          updateProfileConfiguration: (c: object) => Promise<void>;
          reload: (id: string, o: object) => Promise<void>;
        };
      }).developerPrivate;
      await dev.updateProfileConfiguration({ inDeveloperMode: true });
      await dev.reload(id, { failQuietly: true });
    }, browser.extensionId);
    await sleep(1_500);

    const game = await browser.context.newPage();
    watch(game, 'game');
    await game.goto(DEMO_URL);
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    let panel = await browser.context.newPage();
    watch(panel, 'panel');
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#agent')).toContainText('1 wasm module');
    await expect(panel.locator('#bridge')).toHaveText('MCP off');
    await expect(panel.locator('#workbench')).toBeVisible();
    await panel.close();
    await game.close();

    const page = await browser.context.newPage();
    watch(page, 'plain');
    await page.goto(`http://127.0.0.1:${PLAIN_PORT}/`);
    panel = await browser.context.newPage();
    watch(panel, 'panel');
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#nothing-title')).toHaveText('Nothing to analyze in this tab');
    await expect(panel.locator('#workbench')).toBeHidden();
    // A game that only instantiates its wasm on a click: the panel notices without a button press.
    await page.evaluate(() =>
      WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0])),
    );
    await expect(panel.locator('#workbench')).toBeVisible();
    await expect(panel.locator('#nothing')).toBeHidden();

    // Long enough for several reconnect attempts against the dead port.
    await sleep(3_000);
    const runtimeErrors = await admin.evaluate(async (id) => {
      const info = await (chrome as unknown as {
        developerPrivate: { getExtensionInfo: (id: string) => Promise<{ runtimeErrors: { message: string }[] }> };
      }).developerPrivate.getExtensionInfo(id);
      return info.runtimeErrors.map((error) => error.message);
    }, browser.extensionId);
    expect(runtimeErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await browser.close();
    plain.close();
    await demo.stop();
  }
});

// YouTube enforces Trusted Types, where compiling a string is itself a reported violation. The agent
// used to probe `new Function` at start-up, so every YouTube visit left an error on the extension.
test('a page that enforces Trusted Types leaves no extension error', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const wasm = '[0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0]';
  const strict = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "require-trusted-types-for 'script'" });
    res.end(
      `<!doctype html><title>Strict page</title><link rel="icon" href="data:," /><canvas></canvas><script>WebAssembly.instantiate(new Uint8Array(${wasm})).then((r) => { window.keep = r; });</script>`,
    );
  }).listen(PLAIN_PORT);
  const browser = await launchBrowser();
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    const admin = await browser.context.newPage();
    await admin.goto('chrome://extensions');
    await admin.evaluate(async (id) => {
      const dev = (chrome as unknown as {
        developerPrivate: { updateProfileConfiguration: (c: object) => Promise<void>; reload: (id: string, o: object) => Promise<void> };
      }).developerPrivate;
      await dev.updateProfileConfiguration({ inDeveloperMode: true });
      await dev.reload(id, { failQuietly: true });
    }, browser.extensionId);
    await sleep(1_500);
    const page = await browser.context.newPage();
    await page.goto(`http://127.0.0.1:${PLAIN_PORT}/`);
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#agent')).toHaveText('1 wasm module', { timeout: 20_000 });
    await sleep(2_000);
    const runtimeErrors = await admin.evaluate(async (id) => {
      const info = await (chrome as unknown as {
        developerPrivate: { getExtensionInfo: (id: string) => Promise<{ runtimeErrors: { message: string }[] }> };
      }).developerPrivate.getExtensionInfo(id);
      return info.runtimeErrors.map((error) => error.message);
    }, browser.extensionId);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await browser.close();
    strict.close();
  }
});

// The Found list, the editor and the bookmarks are read four times a second. A value that moved in
// the game with no button pressed in the panel proves the panel is live, and the same
// <li> before and after proves it updates in place instead of rebuilding under the cursor.
test('the panel keeps scan hits, the picked address and bookmarks live', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const demo = await startDemoServer();
  const browser = await launchBrowser();
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    const game = await browser.context.newPage();
    await game.goto(DEMO_URL);
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#scan-instance')).toHaveValue('w1');
    // The score also climbs on a clock; paused, it moves only when Mine is clicked, so the value
    // typed into the scan is still the value in memory when the scan runs.
    await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());

    // A value no other address holds, so the score is the one hit and not the 101st of many zeros.
    await panel.evaluate(() =>
      (window as unknown as { __panel: { call: (m: string, p: unknown) => Promise<unknown> } }).__panel.call('page.write', {
        address: 'w1:0x408',
        type: 'i32',
        value: 7654321,
      }),
    );
    await panel.fill('#scan-value', '7654321');
    await panel.press('#scan-value', 'Enter');
    const row = panel.locator('#scan-hits li', { has: panel.locator('button', { hasText: 'w1:0x408' }) });
    await expect(row).toHaveCount(1);
    const first = await row.elementHandle();
    await game.click('#mine');
    await expect(row.locator('.hit--moved')).toHaveCount(1);
    expect(await row.evaluate((item, before) => item === before, first)).toBe(true);

    // One click narrows by movement: the score went up, so "Went up" keeps exactly that address.
    await expect(panel.locator('#scan-quick')).toBeVisible();
    await panel.click('#scan-quick button[data-mode="increased"]');
    await expect(panel.locator('#scan-id')).toContainText('1 match');

    await row.locator('button').click();
    const now = await panel.locator('#pick-now').textContent();
    await game.click('#mine');
    await expect(panel.locator('#pick-now')).not.toHaveText(now ?? '');

    // Write, then Undo puts the value from before the write back.
    await panel.fill('#pick-value', '42');
    await panel.click('#pick-write');
    await expect(panel.locator('#pick-out')).toContainText('-> 42');
    await panel.click('#pick-undo');
    await expect(panel.locator('#pick-out')).toContainText('undone');
    await expect(panel.locator('#pick-undo')).toBeHidden();

    await panel.fill('#bookmark-label', 'score');
    await panel.click('#bookmark-add');
    const bookmark = panel.locator('#bookmark-list-out li', { hasText: 'score' });
    await expect(bookmark).toContainText('i32 now');
    const value = await bookmark.textContent();
    await game.click('#mine');
    await expect(bookmark).not.toHaveText(value ?? '');
  } finally {
    await browser.close();
    await demo.stop();
  }
});

// YouTube Playables and itch.io embeds run the game in a cross-origin iframe that often instantiates
// after the panel opened. The first pick (the top frame, no wasm) must not stick.
test('a game frame that instantiates late is found without a reload', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const wasm = '[0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0]';
  const host = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      req.url?.startsWith('/game')
        ? `<!doctype html><link rel="icon" href="data:," /><canvas></canvas><script>setTimeout(() => WebAssembly.instantiate(new Uint8Array(${wasm})).then((r) => { window.keep = r; }), 4000);</script>`
        : `<!doctype html><title>Playable host</title><link rel="icon" href="data:," /><iframe src="http://localhost:${PLAIN_PORT}/game"></iframe>`,
    );
  }).listen(PLAIN_PORT);
  const browser = await launchBrowser();
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    const page = await browser.context.newPage();
    await page.goto(`http://127.0.0.1:${PLAIN_PORT}/`);
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#nothing-title')).toHaveText('Nothing to analyze in this tab');
    await expect(panel.locator('#advanced')).toBeHidden();
    await expect(panel.locator('#agent')).toHaveText('1 wasm module', { timeout: 20_000 });
    await expect(panel.locator('#workbench')).toBeVisible();
    await expect(panel.locator('#scan-instance')).toHaveValue('w1');
  } finally {
    await browser.close();
    host.close();
  }
});

// YouTube Playables runs every game in a sandboxed iframe, which has no sessionStorage: the page agent
// cannot write a patch down, so the extension carries it across the reload that installs it.
test('a patch survives the reload that installs it in a sandboxed game frame', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const wasm = JSON.stringify(Array.from(buildPatchModule()));
  const host = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      req.url?.startsWith('/game')
        ? `<!doctype html><link rel="icon" href="data:," /><canvas></canvas><p id="score"></p><script>setTimeout(() => WebAssembly.instantiate(new Uint8Array(${wasm})).then((r) => { window.keep = r; setInterval(() => { document.getElementById('score').textContent = String(r.instance.exports.score()); }, 50); }), 1500);</script>`
        : `<!doctype html><title>Playable host</title><link rel="icon" href="data:," /><iframe sandbox="allow-scripts" src="http://localhost:${PLAIN_PORT}/game"></iframe>`,
    );
  }).listen(PLAIN_PORT);
  const browser = await launchBrowser();
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    const page = await browser.context.newPage();
    await page.goto(`http://127.0.0.1:${PLAIN_PORT}/`);
    const score = () => page.frames().find((frame) => frame.url().includes('/game'))!.locator('#score');
    await expect(score()).not.toHaveText('');
    await expect(score()).not.toHaveText('4242');
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#scan-instance')).toHaveValue('w1', { timeout: 20_000 });
    type Hooks = { __panel: { call: (method: string, params?: unknown) => Promise<unknown> } };
    await panel.evaluate(() =>
      (window as unknown as Hooks).__panel.call('page.patch.add', { target: 'score', mode: 'stub', value: 4242 }),
    );
    await page.reload();
    await expect(score()).toHaveText('4242', { timeout: 20_000 });
  } finally {
    await browser.close();
    host.close();
  }
});

// A PlayCanvas or three.js game is JavaScript with a physics engine in wasm (Ammo.js here), so its
// score is in no memory WasmCheat can scan. The panel says so before the human tries. The page also
// carries a megabyte of inline script with no spaces, as minified games do: reading it for .wasm
// references once took seconds and stalled the frame pick on every reload.
test('a page whose only wasm is a physics engine says so, and diagnosing it stays fast', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
  const host = createServer((req, res) => {
    if (req.url?.startsWith('/files/ammo.wasm')) {
      res.writeHead(200, { 'content-type': 'application/wasm' });
      res.end(wasm);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><title>Physics game</title><link rel="icon" href="data:," /><canvas></canvas>` +
        `<script>window.blob = "${'A'.repeat(1_000_000)}";</script>` +
        `<script>WebAssembly.instantiateStreaming(fetch('/files/ammo.wasm')).then((r) => { window.keep = r; });</script>`,
    );
  }).listen(PLAIN_PORT);
  const browser = await launchBrowser();
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    const page = await browser.context.newPage();
    await page.goto(`http://127.0.0.1:${PLAIN_PORT}/`);
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#physics-note')).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator('#physics-note')).toContainText('Ammo.js (Bullet), a physics engine');
    type Hooks = { __panel: { call: (method: string, params?: unknown) => Promise<{ physicsEngine?: string }> } };
    const timed = await panel.evaluate(async () => {
      const started = performance.now();
      const info = await (window as unknown as Hooks).__panel.call('page.diagnose');
      return { ms: performance.now() - started, engine: info.physicsEngine };
    });
    expect(timed.engine).toBe('Ammo.js (Bullet)');
    expect(timed.ms).toBeLessThan(500);
  } finally {
    await browser.close();
    host.close();
  }
});

// A value you cannot read (a health bar): First Scan with Value empty keeps every address as a copy
// of memory, and the movement buttons narrow it. The demo's score is the value that moves.
test('an unknown-value scan narrows by movement to the address that moved', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const demo = await startDemoServer();
  const browser = await launchBrowser();
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    const game = await browser.context.newPage();
    await game.goto(DEMO_URL);
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    await game.evaluate(() => (window as unknown as { __foundry: { pause: () => void } }).__foundry.pause());
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await expect(panel.locator('#scan-instance')).toHaveValue('w1');

    await panel.click('#scan-begin');
    await expect(panel.locator('#scan-hits')).toContainText('Every address is still a candidate');
    // Each pass reports "narrowed …" when it returns; clearing the line first makes every wait real.
    const narrow = async (mode: string) => {
      await panel.evaluate(() => {
        document.querySelector('#scan-out')!.textContent = '';
      });
      await panel.click(`#scan-quick button[data-mode="${mode}"]`);
      await expect(panel.locator('#scan-out')).toContainText('narrowed');
    };
    await narrow('unchanged');
    await game.click('#mine');
    await narrow('increased');
    await narrow('unchanged');
    await game.click('#mine');
    await narrow('increased');
    await expect(panel.locator('#scan-hits button', { hasText: 'w1:0x408' })).toHaveCount(1);
  } finally {
    await browser.close();
    await demo.stop();
  }
});
