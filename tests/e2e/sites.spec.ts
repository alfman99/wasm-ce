import { expect, test, type Page } from '@playwright/test';
import { DEMO_URL, assertPortFree, launchBrowser, startDemoServer } from './harness.js';

// Nothing listens here: this test is about injection, not the bridge.
const DEAD_BRIDGE_PORT = 7397;

const patched = (page: Page) => page.evaluate(() => 'wasmCheatPatched' in WebAssembly);

// The page agent patches WebAssembly in the MAIN world. Doing that on every page made captchas
// (Turnstile, hCaptcha, reCAPTCHA) fail their environment checks in the profile with the extension.
test('WasmCheat stays out of a site until it is turned on, and out of captcha frames always', async () => {
  await assertPortFree(DEAD_BRIDGE_PORT);
  const demo = await startDemoServer();
  const browser = await launchBrowser(undefined, false);
  try {
    const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
    await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), DEAD_BRIDGE_PORT);
    // A Turnstile frame inside a page of the demo's site, served locally: injection goes by URL.
    await browser.context.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Turnstile</title>' }),
    );
    await browser.context.route(`${DEMO_URL}captcha.html`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Sign up</title><iframe src="https://challenges.cloudflare.com/turnstile/if/ov2"></iframe>',
      }),
    );

    const game = await browser.context.newPage();
    await game.goto(DEMO_URL);
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    expect(await patched(game)).toBe(false);

    // The popup picks the web tab used last, and turning the site on reloads it with the agent in.
    const popup = await browser.context.newPage();
    await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
    await expect(popup.locator('#site')).toHaveText('Turn on for 127.0.0.1');
    await popup.locator('#site').click();
    await expect(popup.locator('#site')).toHaveText('Turn off for 127.0.0.1');
    await expect.poll(() => patched(game).catch(() => false)).toBe(true);
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    await expect(popup.locator('#state')).toContainText('1 wasm module');

    // A site that is on still never puts the agent in a captcha frame.
    const signup = await browser.context.newPage();
    await signup.goto(`${DEMO_URL}captcha.html`);
    const captcha = signup.frames().find((frame) => frame.url().startsWith('https://challenges.cloudflare.com/'));
    expect(captcha).toBeDefined();
    await captcha!.waitForLoadState();
    expect(await patched(signup)).toBe(true);
    expect(await captcha!.evaluate(() => 'wasmCheatPatched' in WebAssembly)).toBe(false);

    // Off again: the next load of the site has no agent.
    await popup.reload();
    await expect(popup.locator('#site')).toHaveText('Turn off for 127.0.0.1');
    await popup.locator('#site').click();
    await expect(popup.locator('#site')).toHaveText('Turn on for 127.0.0.1');
    await game.reload();
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    expect(await patched(game)).toBe(false);

    // A tool called on a site that is off (no attach first) turns it on, and reloads the game once so
    // the agent sees its wasm instead of answering "no instances".
    const instances = await popup.evaluate(async (url) => {
      const send = (method: string, params: object) =>
        chrome.runtime.sendMessage({ type: 'wasmcheat.panel.call', method, params }) as Promise<{ result?: unknown; error?: unknown }>;
      const tabs = (await send('ext.listTabs', {})).result as { tabId: number; url: string }[];
      const tabId = tabs.find((tab) => tab.url === url)!.tabId;
      return send('ext.call', { tabId, method: 'page.listInstances', params: {} });
    }, DEMO_URL);
    expect(instances.error).toBeUndefined();
    expect(instances.result).toHaveLength(1);
    expect(await patched(game)).toBe(true);
  } finally {
    await browser.close();
    await demo.stop();
  }
});
