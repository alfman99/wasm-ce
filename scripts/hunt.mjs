#!/usr/bin/env node
// Interactive value hunt against a live tab, one MCP call per invocation but a scan session that
// lives in the page between them. The scan id is remembered in /tmp/wasmcheat-hunt.json because a
// new process means a new MCP server, while the page keeps its sessions.
//
//   node scripts/hunt.mjs find                     # list tabs and wasm instances, remember the newest
//   node scripts/hunt.mjs exact 5162681 i32        # first pass
//   node scripts/hunt.mjs narrow changed           # next passes
//   node scripts/hunt.mjs narrow exact 5000000
//   node scripts/hunt.mjs hits [limit]
//   node scripts/hunt.mjs write w1:0x1f40 999999 i32
//   node scripts/hunt.mjs read w1:0x1f40 i32
//
// TAB and TYPE come from the environment (WASMCHEAT_TAB, WASMCHEAT_TYPE) or the saved state.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../packages/mcp-server/dist/bin.js', import.meta.url));
const STATE = '/tmp/wasmcheat-hunt.json';

const load = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
};
const save = (state) => writeFileSync(STATE, JSON.stringify(state, null, 2));

const [command, ...rest] = process.argv.slice(2);

const SOCKET = process.env.WASMCHEAT_SOCKET ?? '/tmp/wasmcheat.sock';

async function serve() {
  const net = await import('node:net');
  const { unlinkSync } = await import('node:fs');
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport: Transport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new Transport({ command: process.execPath, args: [BIN], env: { ...process.env }, stderr: 'inherit' });
  const client = new McpClient({ name: 'wasmcheat-serve', version: '0.0.0' });
  await client.connect(transport);
  const text = (r) => r.content.find((part) => part.type === 'text')?.text ?? '';
  try {
    unlinkSync(SOCKET);
  } catch {
    // no stale socket
  }
  const run = async (line) => {
    // Split at the first space only: the JSON after it may hold code whose spacing matters.
    const [name, joined = ''] = line.trim().split(/\s(.*)/s);
    if (!name) return '';
    const args = joined.startsWith('{') ? JSON.parse(joined) : {};
    const tool = name.startsWith('wasmcheat_') ? name : `wasmcheat_${name}`;
    const start = Date.now();
    let result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 900_000 });
    if (result.isError && /no WasmCheat extension connected|NO_AGENT/.test(text(result)) && Date.now() - start < 90_000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 900_000 });
    }
    return text(result);
  };
  net
    .createServer((connection) => {
      let buffer = '';
      connection.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.endsWith('\n')) return;
        const line = buffer.trim();
        buffer = '';
        void run(line).then(
          (reply) => connection.end(reply + '\n'),
          (error) => connection.end(`ERROR ${error.message}\n`),
        );
      });
    })
    .listen(SOCKET, () => console.log(`[hunt] session ready on ${SOCKET}`));
  // Stay in serve mode: the rest of this file is the one-shot command path.
  await new Promise(() => {});
}

if (command === 'serve') {
  await serve();
}
if (!command) {
  console.error('usage: hunt.mjs <find|exact|narrow|hits|read|write|freeze|watch> [args]');
  process.exit(2);
}

const state = load();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'wasmcheat-hunt', version: '0.0.0' });
await client.connect(transport);

async function call(tool, args) {
  const start = Date.now();
  let result = await client.callTool({ name: tool, arguments: args }, undefined, {
    // The SDK client gives up after 60 s by default, while an approval wait can last minutes.
    timeout: Number(process.env.WASMCHEAT_RPC_TIMEOUT ?? 900_000),
  });
  const text = (r) => r.content.find((part) => part.type === 'text')?.text ?? '';
  // The extension dials in asynchronously, so a fresh server sees NO_AGENT for a moment.
  while (
    result.isError &&
    /no WasmCheat extension connected|NO_AGENT/.test(text(result)) &&
    Date.now() - start < 30_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 900_000 });
  }
  const body = text(result);
  if (result.isError) {
    console.error(body);
    await client.close();
    process.exit(1);
  }
  const json = body.slice(body.indexOf('{'));
  try {
    return JSON.parse(json);
  } catch {
    return { text: body };
  }
}

async function resolveInstance(tabId) {
  const instances = await call('wasmcheat_list_instances', { tabId });
  const list = Array.isArray(instances) ? instances : (instances.instances ?? []);
  const usable = list.filter((entry) => entry.memory && entry.memory.byteLength > 0);
  if (usable.length === 0) throw new Error('no wasm instance with memory in this tab');
  // The newest instance is the one the game just booted; ids only ever count up per page.
  return usable[usable.length - 1];
}

const tabId = Number(process.env.WASMCHEAT_TAB ?? state.tabId ?? 0);
const type = process.env.WASMCHEAT_TYPE ?? state.type ?? 'i32';

switch (command) {
  case 'find': {
    const tabs = await call('wasmcheat_list_tabs', {});
    const list = Array.isArray(tabs) ? tabs : (tabs.tabs ?? []);
    const tab = Number(process.env.WASMCHEAT_TAB ?? list.find((entry) => /playables|game/i.test(entry.url))?.tabId ?? 0);
    if (!tab) {
      console.error('no candidate tab; pass WASMCHEAT_TAB=<id>');
      process.exit(1);
    }
    await call('wasmcheat_attach', { tabId: tab, waitSeconds: Number(process.env.WASMCHEAT_APPROVE_WAIT ?? 90), reason: 'value hunt' });
    const instance = await resolveInstance(tab);
    save({ ...state, tabId: tab, instanceId: instance.id, scanId: undefined });
    console.log(JSON.stringify({ tabId: tab, instanceId: instance.id, memory: instance.memory, exports: instance.exports.length }));
    break;
  }
  case 'exact':
  case 'narrow': {
    const value = command === 'exact' ? Number(rest[0]) : rest[0] === 'exact' || rest[0] === 'between' ? Number(rest[1]) : undefined;
    const value2 = rest[0] === 'between' ? Number(rest[2]) : undefined;
    const mode = command === 'exact' ? 'exact' : rest[0];
    const instanceId = state.instanceId ?? (await resolveInstance(tabId)).id;
    const params = { tabId, instanceId, type, mode, value, value2, alignment: 1, maxResults: 250_000 };
    if (command === 'exact') {
      const summary = await call('wasmcheat_scan', params);
      save({ ...state, tabId, instanceId, type, scanId: summary.scanId });
      console.log(JSON.stringify({ scanId: summary.scanId, matchCount: summary.matchCount, truncated: summary.truncated, sample: summary.sample?.slice(0, 10) }));
      break;
    }
    if (!state.scanId) {
      console.error('no scan in progress; run `exact <value>` first');
      process.exit(1);
    }
    const summary = await call('wasmcheat_scan', { ...params, scanId: state.scanId });
    console.log(JSON.stringify({ scanId: state.scanId, mode, matchCount: summary.matchCount, sample: summary.sample?.slice(0, 10) }));
    break;
  }
  case 'hits': {
    const limit = Number(rest[0] ?? 20);
    const result = await call('wasmcheat_scan_results', { tabId, scanId: state.scanId, limit });
    console.log(JSON.stringify({ total: result.total, hits: result.hits?.slice(0, limit) }));
    break;
  }
  case 'read': {
    const [address, readType] = rest;
    console.log(JSON.stringify(await call('wasmcheat_read', { tabId, address, type: readType ?? type })));
    break;
  }
  case 'write': {
    const [address, value, writeType] = rest;
    console.log(JSON.stringify(await call('wasmcheat_write', { tabId, address, type: writeType ?? type, value: Number(value) })));
    break;
  }
  case 'freeze': {
    const [address, value] = rest;
    await call('wasmcheat_freeze', { tabId, action: 'set', address, type, value: Number(value) });
    console.log(JSON.stringify({ frozen: address, value }));
    break;
  }
  default: {
    console.error(`unknown command ${command}`);
    process.exit(2);
  }
}

await client.close();
