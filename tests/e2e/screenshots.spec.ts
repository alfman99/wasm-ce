import { mkdir } from 'node:fs/promises';
import { test } from '@playwright/test';
import {
  BRIDGE_PORT,
  BRIDGE_TOKEN,
  DEMO_URL,
  assertPortFree,
  call,
  connectMcp,
  launchBrowser,
  sleep,
  startDemoServer,
  waitForBridge,
} from './harness.js';

/** Temporary: renders the three surfaces so a human can look at them. Not part of the suite. */
test('screenshots', async () => {
  await assertPortFree(BRIDGE_PORT);
  const demo = await startDemoServer();
  const browser = await launchBrowser();
  const worker =
    browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
  await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), BRIDGE_PORT);
  // Show what a real first run looks like: no token, so the extension pairs for one.
  await worker.evaluate(() => chrome.storage.local.set({ bridgeToken: '', bridgeTokenSource: 'none' }));
  const mcp = await connectMcp();
  try {
    await waitForBridge(mcp);
    const page = browser.context.pages()[0] ?? (await browser.context.newPage());
    await page.goto(DEMO_URL);
    await page.waitForSelector('#status');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    for (let i = 0; i < 6; i += 1) await page.click('#mine');
    await sleep(400);
    await page.screenshot({ path: 'docs/img/demo.png' });
    await mkdir('docs/store', { recursive: true });

    const tabs = await call<{ tabId: number; url: string }[]>(mcp, 'wasmcheat_list_tabs');
    const tabId = tabs.data.find((tab) => tab.url.startsWith(DEMO_URL))?.tabId;
    if (!tabId) throw new Error('demo tab missing');
    const panel = await browser.context.newPage();
    await panel.setViewportSize({ width: 1180, height: 900 });
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    const extra = process.env.WASMCHEAT_SHOTS_EXTRA;
    if (extra) {
      await panel.waitForTimeout(900);
      await panel.screenshot({ path: `${extra}/panel-start.png` });
    }
    await call(mcp, 'wasmcheat_attach', { tabId });
    await panel.click('#refresh-status');
    await panel.waitForTimeout(900);
    await panel.fill('#scan-instance', 'w1');
    await panel.selectOption('#scan-type', 'i32');
    await panel.selectOption('#scan-mode', 'exact');
    await panel.fill('#scan-value', '5');
    await panel.click('#scan-begin');
    await panel.waitForSelector('#scan-hits button.link', { timeout: 20_000 });
    // Picking a hit opens the editor beside it: that is the moment the panel exists for.
    await panel.click('#scan-hits button.link');
    await panel.fill('#pick-value', '99999');
    await panel.click('#pick-write');
    await panel.waitForFunction(() => document.querySelector('#pick-out')?.textContent?.includes('->'));
    await panel.waitForTimeout(300);
    await panel.screenshot({ path: 'docs/img/panel.png', fullPage: false });
    if (extra) {
      await panel.screenshot({ path: `${extra}/panel-full.png`, fullPage: true });
      await panel.setViewportSize({ width: 420, height: 900 });
      await panel.screenshot({ path: `${extra}/panel-narrow.png`, fullPage: true });
      await panel.setViewportSize({ width: 1180, height: 900 });
    }

    // The Chrome Web Store takes 1280x800 screenshots; docs/STORE_LISTING.md names these files.
    await panel.setViewportSize({ width: 1280, height: 800 });
    await panel.waitForTimeout(300);
    await panel.screenshot({ path: 'docs/store/1-change-a-value.png' });
    await panel.setViewportSize({ width: 1180, height: 900 });

    await panel.click('#theme-toggle');
    await panel.waitForTimeout(300);
    await panel.screenshot({ path: 'docs/img/panel-dark.png', fullPage: false });
    await panel.setViewportSize({ width: 1280, height: 800 });
    await panel.waitForTimeout(300);
    await panel.screenshot({ path: 'docs/store/2-dark-theme.png' });
    await panel.setViewportSize({ width: 1180, height: 900 });
    await panel.click('#help-open');
    await panel.waitForTimeout(300);
    await panel.screenshot({ path: 'docs/img/help.png', fullPage: false });
    await panel.click('#help-close');
    await panel.click('#theme-toggle');

    const popup = await browser.context.newPage();
    await popup.setViewportSize({ width: 380, height: 560 });
    await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await popup.waitForTimeout(1200);
    await popup.screenshot({ path: 'docs/img/popup.png' });
  } finally {
    await mcp.client.close();
    await browser.close();
    await demo.stop();
  }
});
