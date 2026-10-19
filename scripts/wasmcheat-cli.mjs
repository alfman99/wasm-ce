#!/usr/bin/env node
// One-shot MCP client for manual probing: same stdio path an agent uses, from the shell.
//
//   node scripts/wasmcheat-cli.mjs tabs
//   node scripts/wasmcheat-cli.mjs attach 123456 '{"reason":"find the score","waitSeconds":120}'
//   node scripts/wasmcheat-cli.mjs scan '{"tabId":123,"instanceId":"w1","type":"i32","mode":"exact","value":75}'
//   node scripts/wasmcheat-cli.mjs audit 40
//
// Each run spawns packages/mcp-server/dist/bin.js, so the extension must be running in the
// browser; it reconnects to the bridge on its own. Exit code is 1 when the tool returns an error.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../packages/mcp-server/dist/bin.js', import.meta.url));
const WAIT_MS = Number(process.env.WASMCHEAT_WAIT ?? 20) * 1000;

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const rest = argv.filter((arg) => arg !== '--json');
if (rest.length === 0) {
  console.error('usage: wasmcheat-cli <tool> [json-args] [--json]');
  process.exit(2);
}

const [name, ...tail] = rest;
let args = {};
const joined = tail.join(' ').trim();
if (joined.startsWith('{')) {
  try {
    args = JSON.parse(joined);
  } catch (error) {
    console.error(`bad JSON args: ${error.message}`);
    process.exit(2);
  }
} else if (joined) {
  args = shorthand(name, joined.split(/\s+/)[0]);
}

const ALIASES = { tabs: 'wasmcheat_list_tabs', instances: 'wasmcheat_list_instances', audit: 'wasmcheat_audit' };
const tool = toolName(name);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'wasmcheat-cli', version: '0.0.0' });
await client.connect(transport);

const start = Date.now();
let result = await client.callTool({ name: tool, arguments: args });

// The bridge needs a moment to see the extension after this process opened the port.
while (
  result.isError &&
  /no WasmCheat extension connected|NO_AGENT/.test(text(result)) &&
  Date.now() - start < WAIT_MS
) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  result = await client.callTool({ name: tool, arguments: args });
}

const body = text(result);
console.log(json || result.isError ? body : body.replace(/^([^\n]*)\n\n/, (_m, note) => `${note}\n`));
await client.close();
process.exit(result.isError ? 1 : 0);

function text(result) {
  return (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function toolName(raw) {
  if (raw.startsWith('wasmcheat_')) return raw;
  return ALIASES[raw] ?? `wasmcheat_${raw}`;
}

/** `attach 123`, `instances 123`, `audit 40`, `detach 123`, `read w1:0x408`. */
function shorthand(raw, first) {
  const tabId = Number(first);
  if (raw.includes('attach')) return { tabId, reason: 'manual check from wasmcheat-cli', waitSeconds: 120 };
  if (raw.includes('detach') || raw.includes('instances')) return { tabId };
  if (raw.includes('audit')) return { limit: tabId };
  return Number.isFinite(tabId) ? { tabId } : { address: first };
}
