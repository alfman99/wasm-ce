import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import {
  BRIDGE_PORT,
  DEMO_URL,
  ROOT,
  assertPortFree,
  call,
  connectMcp,
  launchBrowser,
  sleep,
  startDemoServer,
  waitForBridge,
} from './harness.js';

/**
 * Records docs/img/agent-demo.gif and renders docs/img/social-card.png: real MCP calls against
 * the demo game, every call and result taken from what the tools answered while recording. The
 * "you" and "agent" lines are scripted around them, and the footnote says so. Run with
 * `WASMCHEAT_SHOTS=1 npx playwright test tests/e2e/promo.spec.ts`; needs ffmpeg on the PATH. It also
 * leaves the session in test-results/promo-session for the launch videos (docs/press).
 */
const FRAMES = join(ROOT, 'test-results/promo-frames');
// The launch videos are drawn from this: each step's game at 2x and the chat as it stood.
const SESSION = join(ROOT, 'test-results/promo-session');
const GAME_CLIP = { x: 350, y: 118, width: 580, height: 484 };

interface Line {
  who: 'you' | 'agent' | 'tool';
  text: string;
  result?: string;
}

const STAGE = `<!doctype html><meta charset="utf-8"><style>
  :root { --paper:#faf9f7; --surface:#fff; --surface-2:#f4f2ee; --line:#e3ded5; --ink:#1a1917; --ink-2:#5b564d; --ink-3:#6b665c; --accent:#0d7461; --accent-soft:#e7f1ee;
    --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, "SF Mono", Menlo, monospace; }
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 640px; background: var(--paper); font: 15px/1.45 var(--font); color: var(--ink); display: flex; gap: 28px; padding: 36px; align-items: center; }
  .chat { width: 528px; height: 568px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
  .head { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; font-weight: 600; }
  .head small { margin-left: auto; font-weight: 500; color: var(--accent); background: var(--accent-soft); padding: 3px 10px; border-radius: 999px; font-size: 12px; }
  .log { flex: 1; padding: 16px 18px; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; overflow: hidden; }
  .you { align-self: flex-end; max-width: 86%; background: var(--surface-2); border-radius: 10px; padding: 9px 13px; }
  .agent { max-width: 92%; }
  .tool { font: 12.5px/1.5 var(--mono); border-left: 2px solid var(--accent); padding: 2px 0 2px 10px; color: var(--ink-2); }
  .tool b { color: var(--accent); font-weight: 600; }
  .tool span { display: block; color: var(--ink); }
  .game { width: 580px; height: 484px; border-radius: 12px; overflow: hidden; }
  .game img { display: block; width: 100%; }
  .note { position: absolute; left: 36px; bottom: 12px; font-size: 11px; color: var(--ink-3); }
</style>
<div class="chat"><div class="head">Your agent<small>wasmcheat connected</small></div><div class="log" id="log"></div></div>
<div class="game"><img id="game"></div>
<div class="note">The chat is scripted; every tool call and result shown came from WasmCheat against the demo game.</div>`;

let frame = 0;
const steps: { lines: Line[]; game: string }[] = [];
async function shoot(stage: Page, game: Page, lines: Line[], hold: number): Promise<void> {
  const shot = await game.screenshot({ clip: GAME_CLIP });
  const image = shot.toString('base64');
  const name = `${String(steps.length).padStart(2, '0')}.png`;
  writeFileSync(join(SESSION, name), shot);
  steps.push({ lines: [...lines], game: name });
  await stage.evaluate(
    ({ lines, image }) => {
      const log = document.getElementById('log')!;
      log.replaceChildren(
        ...lines.map((line) => {
          const el = document.createElement('div');
          el.className = line.who;
          if (line.who === 'tool') {
            const name = document.createElement('b');
            name.textContent = line.text;
            el.append(name);
            if (line.result) {
              const result = document.createElement('span');
              result.textContent = `→ ${line.result}`;
              el.append(result);
            }
          } else el.textContent = line.text;
          return el;
        }),
      );
      (document.getElementById('game') as HTMLImageElement).src = `data:image/png;base64,${image}`;
    },
    { lines, image },
  );
  await sleep(60);
  const png = await stage.screenshot({ scale: 'css' });
  // gifski plays frames at a fixed rate, so a step is held by repeating its frame.
  for (let i = 0; i < hold; i += 1) {
    writeFileSync(join(FRAMES, `${String(frame).padStart(4, '0')}.png`), png);
    frame += 1;
  }
}

test('promo', async () => {
  test.setTimeout(180_000);
  for (const dir of [FRAMES, SESSION]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  await assertPortFree(BRIDGE_PORT);
  const demo = await startDemoServer();
  const browser = await launchBrowser(2);
  const worker = browser.context.serviceWorkers()[0] ?? (await browser.context.waitForEvent('serviceworker'));
  await worker.evaluate((port) => chrome.storage.local.set({ wasmcheatPort: port }), BRIDGE_PORT);
  const mcp = await connectMcp();
  try {
    await waitForBridge(mcp);
    const game = browser.context.pages()[0] ?? (await browser.context.newPage());
    await game.setViewportSize({ width: 1280, height: 720 });
    await game.goto(DEMO_URL);
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    await game.evaluate(() => (window as unknown as { __foundry: { pause(): void } }).__foundry.pause());
    for (let i = 0; i < 5; i += 1) await game.click('#mine');
    const stage = await browser.context.newPage();
    await stage.setViewportSize({ width: 1200, height: 640 });
    await stage.setContent(STAGE);

    const tabs = await call<{ tabId: number; url: string }[]>(mcp, 'wasmcheat_list_tabs');
    const tabId = tabs.data.find((tab) => tab.url.startsWith(DEMO_URL))!.tabId;
    const score = async (): Promise<number> => Number((await game.textContent('#score'))!.replace(/\D/g, ''));
    const lines: Line[] = [];
    const say = async (line: Line, hold = 14): Promise<void> => {
      lines.push(line);
      // The request stays on top; the newest steps fill the rest, like a chat that has scrolled.
      await shoot(stage, game, lines.length > 8 ? [lines[0]!, ...lines.slice(-7)] : lines, hold);
    };

    await shoot(stage, game, lines, 8);
    await say({ who: 'you', text: 'Give me a million points in this game, and keep them after a reload.' }, 16);

    const probeCode = ((await mcp.client.callTool({ name: 'wasmcheat_guide', arguments: { topic: 'probe' } })).content as { text: string }[])[0]!.text;
    const probe = await call<{ value: { title: string; wasm: { bytes: number } } }>(mcp, 'wasmcheat_run_script', { tabId, code: probeCode });
    await say({ who: 'tool', text: 'wasmcheat_run_script  probe', result: `${probe.data.value.title.split(' ')[0]}: one wasm module, ${probe.data.value.wasm.bytes / 1024} KB of memory` });
    await say({ who: 'agent', text: `It keeps its state in WebAssembly memory. What score do you see?` }, 12);

    const first = await score();
    await say({ who: 'you', text: String(first) }, 10);
    const scan = await call<{ scanId: string; matchCount: number }>(mcp, 'wasmcheat_scan', { tabId, instanceId: 'w1', type: 'i32', mode: 'exact', value: first });
    const found = scan.data.matchCount;
    await say({ who: 'tool', text: `wasmcheat_scan  i32 = ${first}`, result: found === 1 ? '1 address' : `${found} addresses` });
    await say({ who: 'agent', text: `${found === 1 ? 'One address holds' : `${found} addresses hold`} ${first}. Press Mine once so I can be sure it is the score.` }, 14);

    await game.click('#mine');
    await sleep(150);
    const second = await score();
    await say({ who: 'you', text: String(second) }, 10);
    const narrow = await call<{ matchCount: number }>(mcp, 'wasmcheat_scan', { tabId, instanceId: 'w1', type: 'i32', mode: 'exact', value: second, scanId: scan.data.scanId });
    const hits = await call<{ hits: { address: string }[] }>(mcp, 'wasmcheat_scan_results', { tabId, scanId: scan.data.scanId });
    const address = hits.data.hits[0]!.address;
    await say({ who: 'tool', text: `wasmcheat_scan  narrow to ${second}`, result: `${narrow.data.matchCount === 1 ? 'still 1 address' : `${narrow.data.matchCount} addresses`}: ${address}` });

    const write = await call<{ before: number; after: number }>(mcp, 'wasmcheat_write', { tabId, address, type: 'i32', value: 1_000_000 });
    await sleep(150);
    await say({ who: 'tool', text: `wasmcheat_write  ${address} = 1000000`, result: `${write.data.before} -> ${write.data.after}` }, 18);

    const offset = Number.parseInt(address.split(':')[1]!, 16);
    const mod = `const memory = await until(() => wasm()?.memory);\nnew Int32Array(memory.buffer)[${offset / 4}] = 1000000;\nreturn 'score set';`;
    const kept = await call<{ mod: { origin: string } }>(mcp, 'wasmcheat_mod', { tabId, action: 'add', name: 'a million points', code: mod });
    await say({ who: 'tool', text: 'wasmcheat_mod  add "a million points"', result: `kept for ${new URL(kept.data.mod.origin).host}, runs on every load` }, 14);

    await game.reload();
    await game.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('wasm ready'));
    await game.waitForFunction(() => /1[,.\s]?000[,.\s]?000/.test(document.querySelector('#score')?.textContent ?? ''), undefined, { timeout: 15_000 });
    await game.evaluate(() => (window as unknown as { __foundry: { pause(): void } }).__foundry.pause());
    await say({ who: 'agent', text: 'Reloaded: the mod ran again and set 1,000,000. Remove it any time with wasmcheat_mod remove.' }, 40);

    // The social card reuses the last frame, so it shows the same calls and results.
    const last = readFileSync(join(FRAMES, `${String(frame - 1).padStart(4, '0')}.png`)).toString('base64');
    const icon = readFileSync(join(ROOT, 'packages/extension/icons/128.png')).toString('base64');
    await stage.setViewportSize({ width: 1280, height: 640 });
    await stage.setContent(`<!doctype html><meta charset="utf-8"><style>
      * { box-sizing: border-box; margin: 0; }
      body { width: 1280px; height: 640px; background: #faf9f7; color: #1a1917; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; align-items: center; gap: 48px; padding: 0 0 0 64px; overflow: hidden; }
      .copy { width: 430px; flex: none; }
      .brand { display: flex; align-items: center; gap: 12px; font-size: 24px; font-weight: 650; margin-bottom: 30px; }
      .brand img { width: 44px; height: 44px; border-radius: 10px; }
      h1 { font-size: 44px; line-height: 1.1; letter-spacing: -0.02em; font-weight: 700; }
      h1 em { font-style: normal; color: #0d7461; display: block; margin-top: 10px; font-size: 30px; line-height: 1.2; }
      p { margin-top: 20px; font-size: 20px; line-height: 1.45; color: #5b564d; }
      .shot { flex: none; width: 740px; height: 548px; border-radius: 12px 0 0 12px; border: 1px solid #e3ded5; border-right: 0; overflow: hidden; }
      .shot img { display: block; height: 548px; }
    </style>
    <div class="copy"><div class="brand"><img src="data:image/png;base64,${icon}">WasmCheat</div>
      <h1>Ask your AI agent to change any web game. <em>The change comes back on every load.</em></h1>
      <p>A browser extension and an MCP server for Claude Code, Codex, Cursor and other agents.</p></div>
    <div class="shot"><img src="data:image/png;base64,${last}"></div>`);
    await sleep(100);
    await stage.screenshot({ path: join(ROOT, 'docs/img/social-card.png'), scale: 'css' });
    writeFileSync(join(SESSION, 'session.json'), JSON.stringify(steps, null, 2));

    await call(mcp, 'wasmcheat_mod', { action: 'remove', modId: (await call<{ id: string }[]>(mcp, 'wasmcheat_mod', { action: 'list' })).data[0]!.id });
    // One palette for the whole clip, and only the changed rectangle per frame: small and sharp.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '10', '-i', join(FRAMES, '%04d.png'), '-vf',
      'scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-loop', '0', join(ROOT, 'docs/img/agent-demo.gif')], { stdio: 'inherit' });
  } finally {
    await mcp.close();
    await browser.close();
    await demo.stop();
  }
});
