# WasmCheat

A Cheat Engine for WebAssembly that runs entirely in the browser. An MCP agent can attach to a
WebAssembly app in one of your Chrome tabs, scan its linear memory the way Cheat Engine scans a
process, read/write/freeze/watch addresses, and hot-patch exports and imports — with no native
code, no debugger flags, and no DevTools protocol. Every action needs your approval per tab and
lands in an audit log.

It is a research and debugging tool for **programs you own or have explicit permission to
modify**. See [Policy](#policy) before pointing it at anything.

---

## What is in the box

| Package | Role |
| --- | --- |
| `packages/protocol` | The single shared contract: message envelopes, address format, value types, error codes, scan/hook/watch shapes. |
| `packages/page-agent` | Runs in the page's **MAIN world**. Patches `WebAssembly.instantiate*` / `new WebAssembly.Instance` to capture instances, then does the real work: memory access, scanning, freezing, watches, hooks. |
| `packages/extension` | MV3 extension. Injects the page agent at `document_start`, relays RPC from the service worker, owns the human approval gate and the WebSocket to the MCP server. |
| `packages/mcp-server` | Node 22 stdio MCP server. Exposes the `wasmcheat_*` tools, talks to the extension over a local WebSocket, writes the audit log. |
| `packages/demo-app` | A tiny C game compiled to a standalone wasm module, plus a hand-written loader. The test target. |

---

## Requirements

- Node 22+ (`engines` in `package.json`).
- Chrome 116+ (MV3 + `chrome.storage.session`).
- Optional, only to rebuild the demo wasm: an LLVM that knows `wasm32` (Emscripten's bundled
  clang counts — the build script finds it automatically). Without one, the committed
  `packages/demo-app/prebuilt/game.wasm` is used.

## Install and build

```bash
git clone <this repo> wasm-cheat && cd wasm-cheat
npm install
npm run build          # protocol, page-agent, extension, mcp-server, demo
npm run typecheck      # optional, same types the tests use
```

`npm run build` leaves two things you need:

- `packages/extension/dist/` — the unpacked extension (this directory *is* the extension root).
- `packages/mcp-server/dist/bin.js` — the MCP server binary.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `packages/extension/dist`.
4. Pin the extension; the toolbar icon is where approvals happen.

The extension connects to the MCP server on `ws://127.0.0.1:7331/extension` and reconnects with
backoff if the server is not running yet. The port is baked in at build time, so to use another
one: `WASMCHEAT_PORT=7400 npm run build` and start the server with the same value.

## Point an MCP client at it

The server speaks MCP over stdio, so any client works. Claude Desktop style config:

```json
{
  "mcpServers": {
    "wasmcheat": {
      "command": "node",
      "args": ["/absolute/path/to/wasm-cheat/packages/mcp-server/dist/bin.js"],
      "env": { "WASMCHEAT_PORT": "7331" }
    }
  }
}
```

Or run it by hand while iterating:

```bash
npm start           # node packages/mcp-server/dist/bin.js, logs to stderr
```

Environment knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WASMCHEAT_PORT` | `7331` | WebSocket port the extension dials. Must match the extension build. |
| `WASMCHEAT_HOST` | `127.0.0.1` | Bind address. Keep it on loopback. |
| `WASMCHEAT_HOME` | `~/.wasmcheat` | Where `audit.jsonl` is appended. |
| `WASMCHEAT_CLANG` | auto-detected | LLVM used to compile `packages/demo-app/src/game.c`. |

---

## Architecture

```
┌─────────────────────────── Chrome tab (the target) ───────────────────────────┐
│  page scripts                     MAIN world                                  │
│  ───────────                      ──────────                                  │
│  app ↔ WebAssembly.Memory  ←──  page-agent: captured instances,               │
│                                     scan / read / write / freeze / watch /    │
│                                     export+import hooks                       │
│                                        ▲  postMessage (window)                │
│  isolated world                        │                                      │
│  relay.js  ────────────────────────────┘  channel handshake, RPC per id       │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ chrome.runtime.sendMessage
┌───────────────────────────────────────▼───────────────────────────────────────┐
│  extension service worker (sw.js)                                             │
│  · approvals, per tab, in chrome.storage.session                              │
│  · refuses every page.* RPC for a tab without a granted approval              │
│  · injects relay + page-agent on demand, clears approval on navigation        │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ ws://127.0.0.1:7331/extension
┌───────────────────────────────────────▼───────────────────────────────────────┐
│  mcp-server (Node 22, stdio)                                                  │
│  · wasmcheat_* tools  · zod validation  · audit.jsonl                         │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ MCP (stdio)
                                    your agent
```

Why it looks like this:

- **The page agent has to run in the MAIN world.** `WebAssembly.Instance` objects only exist in
  the realm that created them; an isolated-world script sees nothing. The cost is that page
  scripts can also see (and spoof) the `postMessage` channel — the `channelId` handshake only
  prevents cross-talk. The real trust boundary is the extension's approval gate, which lives
  outside the page.
- **The agent is injected at `document_start`, before the app instantiates.** There is no API to
  enumerate pre-existing `WebAssembly.Instance` objects, so capture only works if the patch is in
  place first. If you attach to an already-loaded page, pass `reload: true` and the tab reloads
  with the agent already installed (the reload is audited, and the tab needs approval again).
- **The extension dials the server, not the other way round.** Only the extension can reach tab
  contents, so the MCP server is the listener and the extension is the client. The newest
  connection wins; a stale socket is closed.
- **Scanning runs inside the page.** Snapshot passes loop over typed arrays in the page and only
  addresses plus a small sample travel back over the bridge, so a 16 MB heap scan is not a
  16 MB JSON round-trip.
- **Memory reads re-read `memory.buffer` on every call**, because `memory.grow` detaches the old
  buffer.

### Two WebAssembly facts that shape the tool

- **Imports are bound at instantiation.** A running instance can never gain a replaced import.
  Import hooks are therefore queued as rules that our patched `WebAssembly.instantiate` applies
  to the imports object *before* the engine sees it, and the created hook reports
  `pending: true` for the live instance. `importPatchability` in `wasmcheat_list_instances` says
  `next-instantiation` or `none` — never a fake `live`.
- **An export patch only reaches callers that read the property per call.** Replacing
  `instance.exports.get_score` works if the app calls `instance.exports.get_score()`. Emscripten's
  glue caches the function on first call (`_get_score = wasmExports['get_score']`), so patched
  exports are invisible to it — which is exactly why the demo ships a hand-written loader.

---

## The approval and audit model

- Every tab is denied until you approve it. An agent calls `wasmcheat_attach`, which blocks while
  the request is pending; the request appears in the extension popup with the agent's one-line
  reason. Approve, and the page agent starts in that tab.
- The service worker refuses every `page.*` call for a tab whose stored approval is not
  `granted` (`NEED_APPROVAL`), so a buggy or malicious agent cannot read memory around the gate.
  The gate covers the memory API, not the bridge: the agent still needs a tab id.
- Navigation clears the approval; the tab has to be re-approved after a reload. Revoking
  (`wasmcheat_detach`, or the popup) takes effect immediately.
- Every write, freeze, hook add/remove, attach/detach and approval goes to
  `$WASMCHEAT_HOME/audit.jsonl` (append-only JSON lines, timestamped, with the tab, the address
  and the before/after value where relevant). Read it back with `wasmcheat_audit`.

---

## Tool reference

Addresses are `"<instanceId>:<offset>"`, e.g. `w1:0x408` or `w1:1032`. `instanceId` comes from
`wasmcheat_list_instances`; offsets may be hex or decimal.

| Tool | Purpose |
| --- | --- |
| `wasmcheat_list_tabs` | Tabs the extension can see, with approval state. |
| `wasmcheat_attach` | Ask for approval and start the agent, then return the instances. |
| `wasmcheat_approval_status` | Read a tab's approval state without starting anything. |
| `wasmcheat_detach` | Revoke approval and cut access. |
| `wasmcheat_list_instances` | Instances, memory sizes, exports, import patchability. |
| `wasmcheat_scan` | Snapshot filtered memory, or narrow an existing scan. |
| `wasmcheat_scan_results` | Page through hits of a scan. |
| `wasmcheat_scan_drop` | Free a scan session. |
| `wasmcheat_read` | Typed values (optionally an array) or raw bytes as hex. |
| `wasmcheat_write` | One typed write, returns before → after, audited. |
| `wasmcheat_freeze` | `set` / `clear` / `list` frozen addresses. |
| `wasmcheat_watch` | `add` / `remove` / `list` / `poll` change events. |
| `wasmcheat_hook` | `add` / `list` / `enable` / `remove` export and import hooks. |
| `wasmcheat_audit` | The most recent audit entries. |

### Discovering and attaching

```jsonc
// wasmcheat_list_tabs
{}
// → [{"tabId": 1310636703, "title": "Foundry", "url": "http://127.0.0.1:4173/", "approval": "none", …}]

// wasmcheat_attach
{ "tabId": 1310636703, "reason": "find the score and patch get_score", "waitSeconds": 60 }
// → {"approval": {"state": "granted"}, "pageAgent": {...}, "instances": [
//      {"id": "w1", "memory": {"byteLength": 131072, "growable": true},
//       "exports": [{"name": "tick", "kind": "function", "arity": 1}, …],
//       "importPatchability": "next-instantiation"}]}
```

`reload: true` reloads first, for pages that loaded before the extension did.

### Scanning

Start with `exact` (or `changed` for a value you don't know) to take a snapshot; then narrow that
snapshot with `changed` / `unchanged` / `increased` / `decreased` as the value moves.

```jsonc
// wasmcheat_scan — first pass
{ "tabId": 1310636703, "instanceId": "w1", "type": "i32", "mode": "exact", "value": 75 }
// → {"scanId": "s1", "matchCount": 2, "sample": [...], "memoryByteLength": 131072}

// wasmcheat_scan — narrow, after the app changed the value
{ "tabId": 1310636703, "instanceId": "w1", "type": "i32", "mode": "changed", "scanId": "s1" }
// → {"scanId": "s1", "matchCount": 1, …}

// wasmcheat_scan_results
{ "scanId": "s1", "offset": 0, "limit": 20 }
// → {"hits": [{"address": "w1:0x408", "value": 100}], "total": 1}
```

Parameters: `type` (i8…f64), `mode`, `value`, `tolerance` (floats), `alignment` (defaults to the
type width; `1` catches unaligned data), `maxResults` (default 250 000, sets `truncated`), and
`scanId` to narrow.

### Reading, writing, freezing, watching

```jsonc
{ "tabId": …, "address": "w1:0x408", "type": "i32" }              // wasmcheat_read → values: [100]
{ "tabId": …, "address": "w1:0x408", "length": 16 }               // → hex: "64000000…"
{ "tabId": …, "address": "w1:0x408", "type": "i32", "value": 999999 }  // wasmcheat_write → before/after

{ "tabId": …, "action": "set", "address": "w1:0x400", "type": "i32", "value": 999 }  // wasmcheat_freeze
{ "tabId": …, "action": "clear", "freezeId": "f1" }
{ "tabId": …, "action": "list" }

{ "tabId": …, "action": "add", "address": "w1:0x408", "type": "i32" }  // wasmcheat_watch
{ "tabId": …, "action": "poll", "limit": 50 }   // → [{"address": "w1:0x408", "before": 100, "after": 4242, …}]
```

Freezes re-write the value every 16 ms, so the app cannot win. Watches sample every 50 ms and
buffer up to 200 events per watch; `poll` drains them (MCP is request/response — there is no
server push, so the agent polls).

### Hooking exports and imports

The body is compiled as `function(args, ctx)`: `args` is the argument array, `ctx.call(nextArgs?)`
runs the original, and the return value replaces the result (return nothing to pass it through).

```jsonc
// Double every score read, live, no reload.
{ "tabId": …, "action": "add", "instanceId": "w1", "target": "export", "name": "get_score",
  "body": "return ctx.call(args) + 1000000;", "note": "demo: show a live export patch" }

// Rewrite arguments on the way in.
{ "tabId": …, "action": "add", "instanceId": "w1", "target": "export", "name": "take_damage",
  "body": "ctx.call([0]);" }

// Imports apply at the next instantiation (WebAssembly binds them then).
{ "tabId": …, "action": "add", "instanceId": "w1", "target": "import", "name": "env.log",
  "body": "console.log('mined', args[0]); return ctx.call(args);" }

{ "tabId": …, "action": "enable", "hookId": "h1", "enabled": false }
{ "tabId": …, "action": "remove", "hookId": "h1" }
```

Hooks are recorded per instance and can be stacked; disabling or removing one restores the app's
original behaviour immediately. If the page's CSP forbids eval, `add` returns `HOOK_EVAL_BLOCKED`;
pass a declarative `fallback` instead (`{"mode": "replace-return", "value": 42}`,
`{"mode": "offset-result", "value": 1000}`, or `{"mode": "passthrough"}`).

---

## Demo walkthrough

The demo is a small C clicker (`packages/demo-app/src/game.c`) whose state lives in linear memory:
lives at `0x400`, level at `0x404`, score at `0x408`, ore at `0x40C`.

```bash
npm run build
npm run serve -w @wasmcheat/demo-app     # http://127.0.0.1:4173/
```

Open it, load the extension, start the MCP server, then an agent session looks like this:

```
agent: wasmcheat_list_tabs {}
       → one tab, "Foundry", approval: none
agent: wasmcheat_attach { "tabId": 1310636703, "reason": "find the score" }
       → blocked while you click Approve in the popup → instances: [w1, 131072 bytes]
agent: wasmcheat_scan { "tabId": …, "instanceId": "w1", "type": "i32", "mode": "exact", "value": 75 }
       → scanId s1, 2 matches
       (press Mine a few times in the page between passes)
agent: wasmcheat_scan { "tabId": …, "instanceId": "w1", "type": "i32", "mode": "changed", "scanId": "s1" }
       → 1 match
agent: wasmcheat_scan_results { "scanId": "s1" }
       → {"hits": [{"address": "w1:0x408", "value": 100}]}
agent: wasmcheat_write { "tabId": …, "address": "w1:0x408", "type": "i32", "value": 999999 }
       → the score in the page changes, no reload
agent: wasmcheat_freeze { "tabId": …, "action": "set", "address": "w1:0x400", "type": "i32", "value": 999 }
       → Hazard no longer takes lives
agent: wasmcheat_hook { "tabId": …, "action": "add", "instanceId": "w1", "target": "export",
                        "name": "get_score", "body": "return ctx.call(args) + 1000000;" }
       → every painted score jumps by a million
agent: wasmcheat_audit { "limit": 20 }
       → the attach, the write, the freeze and the hook, with addresses and values
```

`window.__foundry` exposes `pause()`, `resume()` and `snapshot()` so a scan can target a value
that is not moving — the automated test does exactly that.

---

## Tests

```bash
npm test           # build → vitest (37 unit) → playwright (9 end-to-end)
npm run test:unit  # page agent: memory, registry, scanner, hooks — no browser
npm run test:e2e   # real Chromium, real extension, real MCP stdio client
```

The end-to-end suite (`tests/e2e/demo.spec.ts`) launches Chromium with the unpacked extension,
serves the demo, connects a real MCP client to `dist/bin.js`, and then, in order:

1. lists the tab and proves both `attach` and `read` are refused before approval;
2. approves through the actual popup and attaches;
3. pauses, resets, mines three times, scans for 75, narrows `unchanged` then `changed` to
   `w1:0x408`;
4. writes 123456 and asserts the page DOM changes without a reload;
5. freezes lives at 999 and clicks Hazard;
6. reads typed values and raw bytes, watches the address, and asserts a `123456 → 4242` event;
7. adds a `get_score` hook, asserts the painted score grows by 1 000 000, disables it, re-enables
   it, removes it, and asserts the app returns to its original behaviour at each step;
8. asserts the audit log contains every one of those actions;
9. detaches and asserts access is refused again.

Costs and gotchas: one browser and one bridge port, so the suite runs with a single worker and
fails fast if port 7331 is already taken.

## Layout

```
packages/protocol/src/index.ts      shared contract
packages/page-agent/src/            registry (capture), memory, scanner, hooks, runtime
packages/extension/src/             sw.ts (approval + bridge), relay.ts, popup, manifest
packages/extension/dist/            loadable unpacked extension (built)
packages/mcp-server/src/            bridge.ts (WebSocket), server.ts (tools), audit.ts, bin.ts
packages/demo-app/src/game.c        demo target, compiled to prebuilt/game.wasm
tests/unit/                         vitest: memory, registry, scanner, hooks
tests/e2e/                          playwright: harness.ts + demo.spec.ts
```

## Limitations

- Chrome only (MV3). Firefox/Safari have no equivalent page-agent injection story.
- No way to enumerate wasm instances created before the agent was injected; use `reload: true`.
- Import hooks need a (re)instantiation; exports of glue-cached apps (Emscripten default) cannot
  be patched from JS at all — the tool says so rather than pretending.
- The page-agent runs in the MAIN world, so a hostile page can talk to (or lie to) the relay. The
  approval gate protects you from the agent, not from the site you loaded.
- Strict-CSP pages block hook bodies; declarative fallbacks still work.

## Policy

WasmCheat is for programs you own or have explicit written permission to inspect and modify:
your own apps, CTFs and crackmes you are allowed to solve, debugging your own build, teaching.
Do not use it against other people's software, services, or data. Attaching to a tab is a
deliberate human decision every time — keep it that way.
