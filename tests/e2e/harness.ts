import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The end-to-end rig: a real Chrome with the extension loaded, the demo served over HTTP,
 * and the MCP server as a child process reached over stdio exactly like a real client would.
 * Nothing here shortcuts the extension: tools are called through a real MCP client over stdio.
 */

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEMO_PORT = Number(process.env.DEMO_PORT ?? 4174);
// The extension dials a port baked in at build time (WASMCHEAT_PORT, default 7331), so the
// suite has to use the same one and refuse to run against a server someone else started.
// Not 7331: the human's own extension dials that port, and it would answer for its own tabs.
export const BRIDGE_PORT = Number(process.env.WASMCHEAT_PORT ?? 7399);
/**
 * The bridge refuses an extension that cannot present the token, so the suite uses a known one and
 * installs it into the unpacked extension exactly as a human would (one paste, stored locally).
 */
export const BRIDGE_TOKEN = process.env.WASMCHEAT_TOKEN ?? 'e2e-bridge-token-please-change';
export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}/`;

export const PATHS = {
  extension: join(ROOT, 'packages/extension/dist'),
  mcpBin: join(ROOT, 'packages/mcp-server/dist/bin.js'),
  demoServer: join(ROOT, 'packages/demo-app/serve.mjs'),
};

export interface DemoServer {
  stop: () => Promise<void>;
}

export async function startDemoServer(): Promise<DemoServer> {
  const child: ChildProcess = spawn(process.execPath, [PATHS.demoServer], {
    env: { ...process.env, PORT: String(DEMO_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(DEMO_URL);
      if (response.ok) {
        return {
          stop: () =>
            new Promise<void>((resolve) => {
              child.once('exit', () => resolve());
              child.kill('SIGTERM');
            }),
        };
      }
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  child.kill('SIGKILL');
  throw new Error(`demo server never answered at ${DEMO_URL}: ${logs.join('')}`);
}

export interface LaunchedBrowser {
  context: BrowserContext;
  extensionId: string;
  close: () => Promise<void>;
}

export async function launchBrowser(): Promise<LaunchedBrowser> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'wasmcheat-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${PATHS.extension}`,
      `--load-extension=${PATHS.extension}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async (token: string) => {
    // The suite pastes the token like a human would, and says so, because a token with no recorded
    // source would be reported as pasted anyway and the UI copy would be a guess.
    await chrome.storage.local.set({ bridgeToken: token, bridgeTokenSource: 'pasted' });
  }, BRIDGE_TOKEN);
  return {
    context,
    extensionId,
    close: () => context.close(),
  };
}

export interface Mcp {
  client: Client;
  home: string;
  close: () => Promise<void>;
}

export async function connectMcp(): Promise<Mcp> {
  const home = mkdtempSync(join(tmpdir(), 'wasmcheat-home-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.WASMCHEAT_PORT = String(BRIDGE_PORT);
  env.WASMCHEAT_TOKEN = BRIDGE_TOKEN;
  // A pinned token turns pairing off, and one test proves the pairing handshake itself, so ask for
  // pairing explicitly instead of inheriting the production default.
  env.WASMCHEAT_PAIRING = 'on';
  env.WASMCHEAT_HOME = home;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PATHS.mcpBin],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'wasmcheat-e2e', version: '0.1.0' });
  await client.connect(transport);
  return {
    client,
    home,
    close: async () => {
      await client.close();
    },
  };
}

export interface ToolCall<T = Record<string, unknown>> {
  text: string;
  isError: boolean;
  data: T;
}

/** Call a tool and decode the JSON body out of the text content. */
export async function call<T = Record<string, unknown>>(
  mcp: Mcp,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall<T>> {
  const result = await mcp.client.callTool({ name, arguments: args });
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  const text = blocks.map((block) => block.text ?? '').join('\n');
  const isError = Boolean(result.isError);
  return { text, isError, data: decode<T>(text) };
}

/** Our tool results are `optional note` + JSON; recover the JSON part. */
function decode<T>(text: string): T {
  const trimmed = text.trim();
  for (const attempt of [trimmed, trimmed.slice(trimmed.indexOf('\n'))]) {
    const candidate = attempt.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through to the next candidate
    }
  }
  return undefined as T;
}

/** A stray dev server on the bridge port would make the suite talk to the wrong process. */
export async function assertPortFree(port: number): Promise<void> {
  const net = await import('node:net');
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`port ${port} is already in use — stop the other WasmCheat server before running the e2e suite`));
    });
    socket.once('error', () => {
      socket.destroy();
      resolve();
    });
  });
}

export async function waitForBridge(mcp: Mcp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await call(mcp, 'wasmcheat_list_tabs');
    if (!result.isError) return;
    await sleep(250);
  }
  throw new Error('the extension never connected to the MCP bridge');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
