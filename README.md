# WasmCheat

A Cheat Engine for WebAssembly that runs entirely in the browser. An MCP agent can attach to a
WebAssembly app in one of your Chrome tabs, scan its linear memory the way Cheat Engine scans a
process, read/write/freeze/watch addresses, and hot-patch exports and imports — with no native
code, no debugger flags, and no DevTools protocol. Every action needs your approval per tab and
lands in an audit log.

It is a research and debugging tool for **programs you own or have explicit permission to
modify**. See [Policy](#policy) before pointing it at anything.

**If you are an agent (or driving one) and just want to use it:** read
[docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — the order of operations, the symptom-to-tool table and the
traps. This file is the reference; that file is the playbook. `docs/STATUS.md` records what is proven and
what is not.

---

## What is in the box

| Package | Role |
| --- | --- |
| `packages/protocol` | The single shared contract: message envelopes, address format, value types, error codes, scan/hook/watch shapes. |
| `packages/page-agent` | Runs in the page's **MAIN world** and in every Web Worker. Patches `WebAssembly.instantiate*` / `new WebAssembly.Instance` to capture instances, then does the real work: memory access, scanning, freezing, watches, hooks, watchpoint instrumentation. |
| `packages/extension` | MV3 extension. Injects the page agent at `document_start`, relays RPC from the service worker, owns the human approval gate and the WebSocket to the MCP server, and ships the DevTools panel. |
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

## The bridge token

The bridge is a local WebSocket, so it is authenticated: the MCP server mints a random token into
`$WASMCHEAT_HOME/token` on first run (or takes `WASMCHEAT_TOKEN`), the extension sends it in its
`bridge.hello`, and a connection that cannot present it is closed with `1008 bad bridge token` and
never used for a request. Paste it once — `cat ~/.wasmcheat/token` into **Save token** in the
DevTools panel (or the token box in the toolbar popup) — and it survives restarts. A wrong token
shows `token refused` in the panel plus a red `!` badge; saving the right one reconnects at once.

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

### Drive it from a shell, without an agent

`scripts/wasmcheat-cli.mjs` is a one-shot MCP client, so you can poke a real site by hand:

```bash
node scripts/wasmcheat-cli.mjs tabs
node scripts/wasmcheat-cli.mjs attach 1234567 '{"reason":"manual check","waitSeconds":120}'
node scripts/wasmcheat-cli.mjs instances 1234567          # shorthand → {"tabId": …}
node scripts/wasmcheat-cli.mjs scan '{"tabId":1234567,"instanceId":"w1","type":"i32","mode":"exact","value":75}'
node scripts/wasmcheat-cli.mjs audit 40                   # last 40 audit entries
```

Every invocation spawns `dist/bin.js` itself, so the extension reconnects to the bridge each
time; set `WASMCHEAT_WAIT=40` to let it wait longer. Exit code 1 means the tool returned an
error (the message says which).

Environment knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WASMCHEAT_PORT` | `7331` | WebSocket port the extension dials. Must match the extension build. |
| `WASMCHEAT_HOST` | `127.0.0.1` | Bind address. Keep it on loopback. |
| `WASMCHEAT_HOME` | `~/.wasmcheat` | Where `audit.jsonl` and `token` live. |
| `WASMCHEAT_TOKEN` | read from `$WASMCHEAT_HOME/token` | Shared secret the extension must present. Minted on first run with mode `0600`. |
| `WASMCHEAT_RECONNECT_GRACE_MS` | `8000` | How long a tool call waits for the extension to dial back in before reporting `NO_AGENT`. MV3 suspends the service worker after ~30s idle, so the first call after a pause usually arrives mid-reconnect. |
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

### Subframes

Games rarely live in the document you are looking at: a YouTube Playable, an itch.io embed or a
Unity wrapper runs in a **cross-origin iframe**, where a content script injected into the top
document cannot see it. Both content scripts are therefore registered with `all_frames: true`,
each frame's relay announces itself with its `frameId` and URL, and the service worker picks the
frame that actually captured a wasm instance (probing each one with `page.diagnose` when it has
to). `wasmcheat_list_tabs` shows the frames; `wasmcheat_attach` accepts `frameId` to override the
choice.

### Web Workers

Unity, Godot 4 and most itch.io builds instantiate their module **inside a Web Worker**, where the
page realm's `WebAssembly` hook can never see it. The page agent therefore replaces `Worker` itself
and boots a second copy of itself inside each worker (prepending `importScripts('<extension>/dist/worker-agent.js')`
to a small blob wrapper), so worker instances are captured by the same registry, scan store and
hook store as page instances — `wasmcheat_list_workers` reports them, and their instance ids are
namespaced by the worker that owns them (`k1-1`).

The wrapper is installed **at `document_start`**, before the page's own scripts, because a worker
created earlier than the wrapper is invisible forever — game loaders create their worker in their
first script, which is exactly the losing side of that race. The agent cannot build an extension
URL on its own, so the isolated-world relay publishes it on `document.documentElement`
(`data-wasmcheat-agent`) synchronously, and the wrapper resolves it per construction; if the
attribute is ever missing the page gets a plain, uninstrumented worker rather than a broken one.

A worker that starts a worker is captured the same way: each worker agent installs that wrapper too,
so the grandchild's ids chain the names (`k1n1-1` belongs to the worker `k1` started), and a call for
one is routed down the chain rather than refused. The e2e suite covers a page → worker → worker
chain in `nested.html`.

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
- **A store reports nothing.** No engine hook exists for "this instruction wrote this byte", so
  a watchpoint cannot be attached to a compiled module at all. `wasmcheat_find_writes` and
  `wasmcheat_find_reads` therefore rewrite the binary before it compiles: every store gains a
  gated call back into the page agent, and every load gains a gated identity call that reports
  the address it is about to touch. See [Watchpoints](#watchpoints-asking-who-touched-an-address).

---

## The approval and audit model

- Every tab is denied until you approve it. An agent calls `wasmcheat_attach`, which reports the request
  in the extension popup with the agent's one-line reason and then waits on the **approval event**, not on
  a timer: the call returns the moment you click Approve. The same event-based rule applies to
  `wasmcheat_find_writes` / `wasmcheat_find_reads`, which return on the first write/read event the page
  agent reports instead of re-checking status every few hundred milliseconds.
- The service worker refuses every `page.*` call for a tab whose stored approval is not
  `granted` (`NEED_APPROVAL`), so a buggy or malicious agent cannot read memory around the gate.
  The gate covers the memory API, not the bridge: the agent still needs a tab id.
- The grant is scoped to the tab **and the site**: navigating or reloading inside the same site keeps it
  (a game that reloads itself is the normal case), leaving the site revokes it, and closing the tab
  discards it. Revoking (`wasmcheat_detach`, or the popup) takes effect immediately.
- Every mutation is logged, and the extension reports it rather than each caller doing so: a
  write, freeze set/clear, watch add/remove, scan begin/narrow/drop (plus text and pointer scans),
  hook add/enable/disable/remove, patch add/remove/clear, saved-list save/delete, bookmark
  add/remove/clear, a speed change and every deliberate reload. That is one funnel (`callTab`), so a
  human clicking Freeze in the DevTools panel produces the same line an agent's `wasmcheat_freeze`
  would, with the tab, the address and, for writes, `before -> after`. Reads, `scan_results`,
  listing calls and watch polls are not logged: they change nothing and would bury the writes.
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
| `wasmcheat_scan_text` | Find a string or byte pattern (ascii / utf8 / hex bytes). |
| `wasmcheat_scan_results` | Page through hits of a scan. |
| `wasmcheat_scan_drop` | Free a scan session. |
| `wasmcheat_saved` | `list` / `save` / `open` / `delete` named scan lists that survive a reload. |
| `wasmcheat_bookmark` | `list` / `add` / `remove` / `clear` a named address list (label → address), kept per site. |
| `wasmcheat_list_workers` | Web Workers, including module workers, that own their own wasm. |
| `wasmcheat_pointer_scan` | Find pointer paths whose last offset lands on an address. |
| `wasmcheat_pointer_resolve` | Follow a saved path and return the current address. |
| `wasmcheat_read` | Typed values (optionally an array) or raw bytes as hex. |
| `wasmcheat_write` | One typed write, returns before → after, audited. |
| `wasmcheat_freeze` | `set` / `clear` / `list` frozen addresses. |
| `wasmcheat_watch` | `add` / `remove` / `list` / `poll` change events. |
| `wasmcheat_hook` | `add` / `list` / `enable` / `remove` export and import hooks. |
| `wasmcheat_find_writes` | Which function writes to an address? Reloads with an instrumented module. |
| `wasmcheat_find_reads` | Which function reads an address? Same mechanism, load probes instead of store hooks. |
| `wasmcheat_trace` | `arm` / `status` / `poll` / `clear` / `stop` for a watchpoint (`kind`: `read` or `write`). |
| `wasmcheat_patch` | `add` / `list` / `remove` / `clear` function-body patches: stub a function with a constant return. |
| `wasmcheat_speed` | Speed hack: scale the page clock (0–20x, `0` freezes it), or `reset`. |
| `wasmcheat_diagnose` | Why is the instance list empty? Counts, frames, wasm URLs, one-line hint. |
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

```jsonc
// wasmcheat_scan — comparison operators and deltas work in any pass
{ "mode": "less", "value": 100 }              // also: not-equal, greater, less-or-equal,
                                              // greater-or-equal, between (+ "value2"), increased-by,
                                              // decreased-by, unchanged
// wasmcheat_scan_text — strings and byte patterns
{ "tabId": …, "instanceId": "w1", "text": "combo", "encoding": "ascii", "caseSensitive": false }
{ "tabId": …, "instanceId": "w1", "text": "deadbeef", "encoding": "bytes" }
// → {"encoding": "ascii", "matches": 3, "sample": [{"address": "w1:0x210", "preview": "…"}]}
// wasmcheat_saved — keep a narrowed list across a reload
{ "tabId": …, "action": "save", "name": "player health", "scanId": "s1" }
{ "tabId": …, "action": "list" }                       // [{ "name", "matchCount", "mode", "type", "createdAt" }]
{ "tabId": …, "action": "open", "name": "player health" } // → { "scanId": "s2", "instanceId": "w1", … }
```

A scan session lives in page memory, so it dies with the page — and a game that reloads, or an agent
that reloads the tab to install a hook, is the normal case. Naming a list stores the surviving
addresses (plus the values they held) in the page's own `sessionStorage`: it survives a reload of
that tab, does not leak into another tab, and the re-opened list narrows exactly like a fresh scan
(`changed`, `increased`, …). The DevTools panel has the same four actions under **Saved scans**.

Parameters: `type` (i8…f64), `mode`, `value` (and `value2` for `between`), `tolerance` (floats,
defaults to `max(|value|·1e-6, 1e-6)`), `alignment` (defaults to the type width; `1` catches
unaligned data), `range` (`{start, end}`), `maxResults` (default 250 000, sets `truncated`), and
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

## Watchpoints: asking "who touched this address?"

`wasmcheat_find_writes` and `wasmcheat_find_reads` are Cheat Engine's breakpoints, translated to
wasm:

```jsonc
{ "tabId": …, "address": "w1:0x408", "type": "i32" }
// find_writes → {"installed": true,
//   "hits": [{"kind": "write", "funcIndex": 3, "funcName": "mine", "previous": 75, "value": 100, …}],
//   "functions": [{"name": "mine", "funcIndex": 3, "hits": 12}]}

{ "tabId": …, "address": "w1:0x408", "type": "i32" }   // wasmcheat_find_reads
// → {"hits": [{"kind": "read", "funcName": "get_score", "value": 25, …}],
//    "functions": [{"name": "get_score", "hits": 331}, {"name": "tick", "hits": 4}]}
```

Reads answer a different question than writes: the writer tells you where a value comes from, the
reader tells you what the value is *used for*. For a health bar, the reader is the code that
decides the player dies.

How it works, because the constraint is the interesting part:

1. WebAssembly gives the host no notification when a `store` executes, and a compiled module
   cannot be modified. So the watchpoint has to be in the binary *before* the engine sees it.
2. The tool arms the watchpoint, then reloads the tab (the approval survives, since it is our
   own reload of the page you already approved). Your module is rewritten as it streams past one
   mutable `i32` global, one import (`__wasmcheat.on_store` or `on_read`), one export
   (`__wc_arm`), and then:
   - **writes**: after every store instruction, `global.get flags; if (flags) { on_store(funcIndex) }`.
     A store leaves the stack empty, so appending is always safe.
   - **reads**: before every load, `call probe`, where the probe is `(i32) -> (i32)`:
     `global.get flags; if (flags) { on_read(addr + offset, funcIndex) }; addr`. The address is
     already on the stack, the probe hands it back unchanged, and no stack analysis is needed at
     all. One probe is generated per (function, memory offset) pair — the offset has to be baked
     in because compilers address globals as `i32.const 0; i32.load offset=1032`.
3. `funcIndex` is a constant per call site, which is the attribution: it names the function that
   performed the access. The page agent diffs the watched address on every callback and records
   the hit with the value before and after.
4. `wasmcheat_trace {action: "stop"}` removes the rewriting for the next reload, and nothing
   stays behind in the page.

Honest limits:

- The watchpoint needs a reload; a module that is already compiled can never be instrumented.
  When you arm a live page, the status says so instead of pretending.
- The gated check costs one global read and a branch per store, and one call per load, even when
  disarmed; while armed every access is a call into the page agent, which is slower than running
  free. Only the watchpoint you asked for is instrumented: `find_reads` leaves stores untouched
  and vice versa. That is the same trade Cheat Engine makes with a hardware breakpoint.
- `memory.copy` / `memory.fill` are reported as writes only: they take a length on top of the
  stack, so a `(i32) -> (i32)` probe would see the length instead of an address.
- Atomic (thread) loads and SIMD are rejected by the rewriter rather than silently missed; a page
  that uses them reports the rewrite as unsupported instead of returning an empty hit list.
- Functions the module does not export appear as `wasm-function[12]`. That is all the identity
  the engine has; the index still lets you map it to a disassembly.
- Modules using SIMD (`0xFD`) or atomics (`0xFE`) are rejected with `UNSUPPORTED` rather than
  rewritten half-way. Everything Emscripten, Unity and clang emit today (element segments,
  start functions, indirect calls) is handled.

## Patching a function body

Hooks can only reach the surface a module exposes: imports and exports. Everything a module keeps to
itself — the damage routine, a cooldown, a check — has no seam to wrap, so the only way to switch it
off is to change the code. `wasmcheat_patch` does exactly that, in the same rewrite pass the
watchpoints use:

```jsonc
{ "tabId": …, "action": "add", "target": "take_damage", "mode": "stub", "value": 0 }
// → {"patch": {"id": "p1", "target": "take_damage", "mode": "stub", "value": 0,
//              "applied": true, "funcIndex": 5, "applications": 1}, …}
```

- `mode: "stub"` replaces the body with `const value` (default 0) of the function's result type, so
  `take_damage` still returns, and no longer does anything. Every caller is affected, because the
  stub is the function.
- `mode: "empty"` is for void functions: the body becomes a bare `return`.
- `target` is an export name, or `wasm-function[N]` for a function the module does not export —
  `wasmcheat_list_instances` shows both spellings next to each function it reports.
- The stub lives in the binary, so it also reaches callers that cached an export reference, which is
  the one thing a JS hook can never do.
- Patches persist across reloads (`sessionStorage`, per origin, exactly like arming a watchpoint) and
  stay until `remove` / `clear`, which reload the tab so the original body comes back.
- `applied` is false until a module has been instantiated with the patch: a compiled module can never
  be edited. The tool waits for the instantiation the reload triggers, so `applied: true` means the
  code you are talking to is the code you patched.

The rewriter refuses to guess: SIMD, atomic, and multi-value result functions are reported as
unsupported instead of being stubbed into a module that no longer validates.

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
npm test           # build → vitest (121 unit) → playwright (19 end-to-end)
npm run test:unit  # page agent: memory, registry, scanner, hooks, trace, rewriter — no browser
npm run test:e2e   # real Chromium, real extension, real MCP stdio client
```

The end-to-end suite (`tests/e2e/demo.spec.ts`) launches Chromium with the unpacked extension,
serves the demo, connects a real MCP client to `dist/bin.js`, and then, in order:

1. lists the tab and proves both `attach` and `read` are refused before approval;
2. approves through the actual popup and attaches;
3. pauses, resets, mines three times, scans for 75, narrows `unchanged` then `changed` to `w1:0x408`;
4. writes 123456 and asserts the page DOM changes without a reload;
5. freezes lives at 999 and clicks Hazard;
6. reads typed values and raw bytes, watches the address, and asserts a `123456 → 4242` event;
7. adds a `get_score` hook, asserts the painted score grows by 1 000 000, then disables, re-enables
   and removes it, asserting the original behaviour at each step;
8. performs every kind of mutation and asserts each lands in the one audit funnel;
9. arms a write watchpoint, reloads, mines, and asserts `mine` is named as the writer of `0x408`;
10. arms a read watchpoint and asserts `get_score` is named as the reader;
11. stubs `get_score` with `wasmcheat_patch`, reloads, asserts the page paints 777 while a
    neighbouring export still works, then removes the patch;
12. scans for a pointer chain and resolves it back to the score address;
13. drives a worker the page creates, and asserts the worker is listed and its death reported;
14. detaches and asserts access is refused again;
15. opens the demo inside a genuinely cross-origin iframe and drives it there;
16. drives the tab from the DevTools panel alone, with no agent and no popup;
17. saves a scan list, reloads the tab and keeps narrowing the restored list;
18. attaches to a page whose wasm lives in a Web Worker, writes to the worker's memory, scans and
    narrows there, and sees the worker's own published state change;
19. bookmarks the score address, reloads, reads through the remembered address and forgets it.

Costs and gotchas: one browser and one bridge port, so the suite runs with a single worker and
fails fast if the port is already taken (it picks `7399` by default so it does not collide with a
server you have running).

## Layout

```
packages/protocol/src/index.ts      shared contract
packages/page-agent/src/            registry (capture), memory, scanner, hooks, trace, runtime
packages/extension/src/             sw.ts (approval + bridge), relay.ts, popup, panel.ts, devtools.ts, manifest
packages/extension/dist/            loadable unpacked extension (built)
packages/wasm-instrument/src/       wasm binary rewriter: watchpoint instrumentation + function stubs
packages/mcp-server/src/            bridge.ts (WebSocket), server.ts (tools), audit.ts, bin.ts
packages/demo-app/src/game.c        demo target, compiled to prebuilt/game.wasm
packages/demo-app/framed.html       the demo inside a cross-origin iframe (subframe test)
packages/demo-app/worker.html       the demo instantiated inside a Web Worker (worker test)
tests/unit/                         vitest: memory, registry, scanner, hooks, wasm exports
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
- The speed hack overrides `performance.now`, `Date.now` and `requestAnimationFrame` in the page
  realm only; clock reads inside a worker keep real time.
- The panel's memory viewer dumps bytes and pans by row, but it cannot follow a pointer yet.
  `docs/STATUS.md` keeps the current list.

## Policy

WasmCheat is for programs you own or have explicit written permission to inspect and modify:
your own apps, CTFs and crackmes you are allowed to solve, debugging your own build, teaching.
Do not use it against other people's software, services, or data. Attaching to a tab is a
deliberate human decision every time — keep it that way.
