#!/usr/bin/env node
/**
 * One command to have something to hack.
 *
 * Serves the bundled demo game, opens it, and prints the two things a first run needs: where the
 * unpacked extension lives, and the MCP config block. It does not start the MCP server itself,
 * because the server belongs to whatever client (Claude, Codex, a shell) is driving the tools.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 4173);
const DEMO_URL = `http://127.0.0.1:${PORT}/`;
const EXTENSION = join(ROOT, 'packages/extension/dist');
const BIN = join(ROOT, 'packages/mcp-server/dist/bin.js');

const missing = [];
if (!existsSync(join(EXTENSION, 'manifest.json'))) missing.push('packages/extension/dist');
if (!existsSync(BIN)) missing.push('packages/mcp-server/dist/bin.js');
if (missing.length > 0) {
  console.error(`Build first: missing ${missing.join(', ')}.\n\n  npm install && npm run build\n`);
  process.exit(1);
}

const server = spawn(process.execPath, [join(ROOT, 'packages/demo-app/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(DEMO_URL);
    if (response.ok) break;
  } catch {
    // not up yet
  }
  await new Promise((done) => setTimeout(done, 150));
}

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
spawn(opener, [DEMO_URL], { stdio: 'ignore', detached: true }).on('error', () => {
  console.log(`Open ${DEMO_URL} yourself.`);
});

console.log(`
WasmCheat demo is up at ${DEMO_URL}

  1. Load the extension: chrome://extensions → Developer mode on → Load unpacked → 
     ${EXTENSION}
  2. Open DevTools on the demo tab (⌥⌘I) and pick the WasmCheat panel.
  3. Type the score you can see into Scan and press First Scan. There is nothing to attach.

For an agent, point the client at:

  {
    "mcpServers": {
      "wasmcheat": { "command": "node", "args": ["${BIN}"] }
    }
  }

The bridge token looks after itself: the extension pairs with the server on first connect.
Ctrl+C stops the demo server.
`);

const stop = () => {
  server.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
