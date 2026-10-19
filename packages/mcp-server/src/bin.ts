import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { createServer } from './server.js';
import { auditPath } from './audit.js';

/**
 * Entry point. stdout is reserved for MCP frames, so every log line goes to stderr.
 */

const port = Number(process.env.WASMCHEAT_PORT ?? 7331);
const host = process.env.WASMCHEAT_HOST ?? '127.0.0.1';

const bridge = new Bridge({ host, port, requestTimeoutMs: 30_000 });

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
