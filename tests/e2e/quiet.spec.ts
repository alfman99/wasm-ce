import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { DEMO_URL, assertPortFree, launchBrowser, sleep, startDemoServer } from './harness.js';

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
