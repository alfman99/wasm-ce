import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { createServer } from './server.js';
import { auditPath } from './audit.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Entry point. stdout is reserved for MCP frames, so every log line goes to stderr.
 */

const port = Number(process.env.WASMCHEAT_PORT ?? 7331);
const host = process.env.WASMCHEAT_HOST ?? '127.0.0.1';

/**
 * The bridge token is what stops any other local process from impersonating the extension. It is
 * read from `WASMCHEAT_TOKEN` when set, otherwise persisted under the WasmCheat home so the same
 * token survives restarts and the human only ever pastes it into the extension once.
 */
function resolveToken(): { token: string; from: 'env' | 'file'; path: string } {
  const path =
    process.env.WASMCHEAT_TOKEN_FILE ??
    join(process.env.WASMCHEAT_HOME ?? join(homedir(), '.wasmcheat'), 'token');
  const fromEnv = process.env.WASMCHEAT_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, from: 'env', path };
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved) return { token: saved, from: 'file', path };
  }
  const minted = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${minted}\n`, { mode: 0o600 });
  return { token: minted, from: 'file', path };
}

const { token, from, path: tokenPath } = resolveToken();

const bridge = new Bridge({ host, port, requestTimeoutMs: 30_000, token });

try {
  await bridge.start();
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  const hint =
    code === 'EADDRINUSE'
      ? `port ${port} is already in use — another WasmCheat server may be running (kill it, or set WASMCHEAT_PORT)`
      : (error as Error).message;
  process.stderr.write(`[wasmcheat] cannot start bridge on ${host}:${port}: ${hint}\n`);
  process.exit(1);
}

process.stderr.write(`[wasmcheat] bridge listening on ws://${host}:${port}/extension\n`);
process.stderr.write(`[wasmcheat] audit log: ${auditPath()}\n`);
process.stderr.write(
  from === 'env'
    ? '[wasmcheat] bridge token: from WASMCHEAT_TOKEN\n'
    : `[wasmcheat] bridge token: ${tokenPath} — paste it into the WasmCheat panel (or open the popup) once\n`,
);
process.stderr.write('[wasmcheat] load packages/extension as an unpacked extension, then let an agent in\n');

bridge.on('bridge.disconnected', () => {
  process.stderr.write('[wasmcheat] waiting for the extension to reconnect\n');
});

const server = createServer(bridge);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[wasmcheat] MCP server ready on stdio\n');

async function shutdown(): Promise<void> {
  await bridge.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
