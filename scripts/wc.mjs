#!/usr/bin/env node
// Client for the persistent session started by `node scripts/hunt.mjs serve`:
//
//   node scripts/wc.mjs list_instances '{"tabId":2039197561}'
//   node scripts/wc.mjs scan '{"tabId":2039197561,"instanceId":"w1","type":"i32","mode":"exact","value":75}'
//   node scripts/wc.mjs run_script '{"tabId":2039197561}' --code probe.js --var WANTED='["Character"]'
//   node scripts/wc.mjs mod '{"tabId":2039197561,"action":"add","name":"aim line"}' --code mod.js
//
// --code puts a file's text in the `code` argument (several are joined in order); --var NAME=JSON
// puts `const NAME = JSON;` before it, so one script can take parameters.
//
// One MCP session is kept open by the server process, so a call costs milliseconds instead of a
// service-worker reconnect per invocation.

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const SOCKET = process.env.WASMCHEAT_SOCKET ?? '/tmp/wasmcheat.sock';
const [tool, ...tail] = process.argv.slice(2);
if (!tool) {
  console.error('usage: wc.mjs <tool> [json-args] [--code file]... [--var NAME=JSON]...');
  process.exit(2);
}

const json = [];
const code = [];
for (let i = 0; i < tail.length; i += 1) {
  if (tail[i] === '--code') code.push(readFileSync(tail[++i], 'utf8'));
  else if (tail[i] === '--var') {
    const [name, ...value] = tail[++i].split('=');
    code.unshift(`const ${name} = ${value.join('=')};`);
  } else json.push(tail[i]);
}
let args = json.join(' ').trim();
if (code.length > 0) args = JSON.stringify({ ...(args ? JSON.parse(args) : {}), code: code.join('\n') });
const line = `${tool} ${args}`.trim();
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
