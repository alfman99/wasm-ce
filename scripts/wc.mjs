#!/usr/bin/env node
// Client for the persistent session started by `node scripts/hunt.mjs serve`:
//
//   node scripts/wc.mjs list_instances '{"tabId":2039197561}'
//   node scripts/wc.mjs scan '{"tabId":2039197561,"instanceId":"w1","type":"i32","mode":"exact","value":75}'
//
// One MCP session is kept open by the server process, so a call costs milliseconds instead of a
// service-worker reconnect per invocation.

import { connect } from 'node:net';

const SOCKET = process.env.WASMCHEAT_SOCKET ?? '/tmp/wasmcheat.sock';
const [tool, ...tail] = process.argv.slice(2);
if (!tool) {
  console.error('usage: wc.mjs <tool> [json-args]');
  process.exit(2);
}

const line = `${tool} ${tail.join(' ')}`.trim();
const socket = connect(SOCKET);
socket.on('connect', () => socket.write(`${line}\n`));
let reply = '';
socket.on('data', (chunk) => {
  reply += chunk.toString();
});
socket.on('error', (error) => {
  console.error(`no session on ${SOCKET}: ${error.message}. Start one with: node scripts/hunt.mjs serve`);
  process.exit(1);
});
socket.on('close', () => {
  process.stdout.write(reply);
  process.exit(/^ERROR|^\w+: /.test(reply) ? 1 : 0);
});
