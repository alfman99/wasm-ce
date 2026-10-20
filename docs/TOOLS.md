# Tool reference

Every MCP tool, with examples, and the shell clients for driving them without an agent. How to
connect an agent is in the [README](../README.md#connect-your-agent); the method for changing an app
is the [agent guide](AGENT_GUIDE.md) and the [mod-any-webapp skill](../.agents/skills/mod-any-webapp/SKILL.md).

## Tools

Addresses are `"<instanceId>:<offset>"`, e.g. `w1:0x408` or `w1:1032`. `instanceId` comes from
`wasmcheat_list_instances`; offsets may be hex or decimal.

| Tool | Purpose |
| --- | --- |
| `wasmcheat_guide` | The method for changing an app, step by step, and the scripts it uses (`topic`: workflow, routes, probe, il2cpp, mod-template, example-playcanvas, example-unity). |
| `wasmcheat_list_tabs` | Tabs the extension can see, with agent state. Every other tool defaults to the tab in front. |
| `wasmcheat_attach` | Start (or heal) the page agent and return the instances. |
| `wasmcheat_detach` | Forget the tab and drop the agent it injected. |
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
| `wasmcheat_run_script` | Run JavaScript in the game frame and get its value back, for what the game keeps in JavaScript (a PlayCanvas scene, a save). Audited with its code. See [Scripts and mods](#scripts-and-mods). |
| `wasmcheat_mod` | `add` / `list` / `remove` scripts kept for a game: an added one runs now and on every load of that game's frame. See [Scripts and mods](#scripts-and-mods). |
| `wasmcheat_find_writes` | Which function writes to an address? Reloads with an instrumented module. |
| `wasmcheat_find_reads` | Which function reads an address? Same mechanism, load probes instead of store hooks. |
| `wasmcheat_trace` | `arm` / `status` / `poll` / `clear` / `stop` for a watchpoint (`kind`: `read` or `write`). |
| `wasmcheat_patch` | `add` / `list` / `remove` / `clear` function-body patches: stub a function with a constant return. |
| `wasmcheat_speed` | Speed hack: scale the page clock (0 to 20x, `0` freezes it), or `reset`. |
| `wasmcheat_diagnose` | Why is the instance list empty? Counts, frames, wasm URLs, one-line hint. |
| `wasmcheat_audit` | The most recent audit entries. |

### Discovering and attaching

```jsonc
// wasmcheat_list_tabs
{}
// → [{"tabId": 123, "title": "Foundry", "url": "http://127.0.0.1:4173/", "active": true, …}]

// wasmcheat_attach
{ "tabId": 123 }
// → {"pageAgent": {...}, "instances": [
//      {"id": "w1", "memory": {"byteLength": 131072, "growable": true},
//       "exports": [{"name": "tick", "kind": "function", "arity": 1}, …],
//       "importPatchability": "next-instantiation"}]}
```

`reload: true` reloads first, for pages that loaded before the extension did.

### Scanning

Start with `exact` (or `changed` for a value you don't know) to take a snapshot; then narrow that
snapshot with `changed` / `unchanged` / `increased` / `decreased` as the value moves.

```jsonc
// wasmcheat_scan: first pass
{ "tabId": 123, "instanceId": "w1", "type": "i32", "mode": "exact", "value": 75 }
// → {"scanId": "s1", "matchCount": 2, "sample": [...], "memoryByteLength": 131072}

// wasmcheat_scan: narrow, after the app changed the value
{ "tabId": 123, "instanceId": "w1", "type": "i32", "mode": "changed", "scanId": "s1" }
// → {"scanId": "s1", "matchCount": 1, …}

// wasmcheat_scan_results
{ "scanId": "s1", "offset": 0, "limit": 20 }
// → {"hits": [{"address": "w1:0x408", "value": 100}], "total": 1}
```

```jsonc
// wasmcheat_scan: comparison operators and deltas work in any pass
{ "mode": "less", "value": 100 }              // also: not-equal, greater, less-or-equal,
                                              // greater-or-equal, between (+ "value2"), increased-by,
                                              // decreased-by, unchanged
// wasmcheat_scan_text: strings and byte patterns
{ "tabId": …, "instanceId": "w1", "text": "combo", "encoding": "ascii", "caseSensitive": false }
{ "tabId": …, "instanceId": "w1", "text": "deadbeef", "encoding": "bytes" }
// → {"encoding": "ascii", "matches": 3, "sample": [{"address": "w1:0x210", "preview": "…"}]}
// wasmcheat_saved: keep a narrowed list across a reload
{ "tabId": …, "action": "save", "name": "player health", "scanId": "s1" }
{ "tabId": …, "action": "list" }                       // [{ "name", "matchCount", "mode", "type", "createdAt" }]
{ "tabId": …, "action": "open", "name": "player health" } // → { "scanId": "s2", "instanceId": "w1", … }
```

A scan session lives in page memory, so it dies with the page, and a game that reloads, or an agent
that reloads the tab to install a hook, is the normal case. Naming a list stores the surviving
addresses (plus the values they held) in the page's own `sessionStorage`: it survives a reload of
that tab, does not leak into another tab, and the re-opened list narrows exactly like a fresh scan
(`changed`, `increased`, …). The DevTools panel has the same four actions under **Saved scans**.

Parameters: `type` (i8…f64), `mode`, `value` (and `value2` for `between`), `tolerance` (floats,
defaults to `max(|value|·1e-6, 1e-6)`), `alignment` (defaults to the type width; `1` catches
unaligned data), `from` / `to` (byte bounds of the scan; omit for the whole memory), `maxResults`
(default 250 000, sets `truncated`), and `scanId` to narrow. The page-layer call spells the bounds
`range: {start, end}`: that is what the panel sends; the MCP tool takes `from` / `to` and builds it.

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
buffer up to 200 events per watch; `poll` drains them (MCP is request/response: there is no
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


## Scripts and mods

For what an app keeps in JavaScript (a game engine's scene, a framework's state, a save) and for
changes that should come back on every load.

```jsonc
// wasmcheat_run_script: an expression, or a function body that returns; both may await
{ "tabId": 123, "code": "pc.app.root.children.map((e) => e.name)" }
// → {"type": "array", "value": ["Root", "UI"], "ms": 1}
{ "tabId": 123, "code": "const save = await ytgame.game.loadData(); return save.slice(0, 200);", "timeoutSeconds": 60 }

// wasmcheat_mod: keep a script for the site of the game frame
{ "tabId": 123, "action": "add", "name": "aim line", "code": "…" }   // runs it now; kept only if it works
{ "tabId": 123, "action": "list" }                                  // this tab's mods; omit tabId for all
{ "action": "remove", "modId": "m1a2b3" }                          // stops it from the next load on
```

- The code runs in the frame that holds the game, even a cross-origin iframe, with no frame to pick.
  The value comes back JSON-safe and is cut at 64 KB; `timeoutSeconds` is 1 to 120 (default 30).
- Every script gets two helpers. `until(check, timeoutMs = 30000, everyMs = 100)` waits for `check()`
  to return something truthy and resolves to it (the check may be async; one that throws counts as
  not yet). `wasm(id = 'latest')` returns the captured instance as `{id, memory, exports}`; take
  `memory.buffer` again on every use, because the memory grows.
- A mod is kept in the extension's storage with its code and the origin of the game frame (for a
  YouTube Playable, `*.playables.usercontent.goog`, not youtube.com). It runs on every load of that
  origin, once per page, and survives browser restarts. It starts before the game exists, so it waits
  with `until`, and finds what it needs by name because addresses move between loads.
- Every run and every mod add or remove is in the audit log, with its code. A page whose
  Content-Security-Policy forbids eval answers `HOOK_EVAL_BLOCKED`.
- The panel's Script card does the same: **Run**, and **Run and keep** with the list of kept mods.
- How to write one, per engine, with two complete examples: the
  [mod-any-webapp skill](../.agents/skills/mod-any-webapp/SKILL.md), also served by `wasmcheat_guide`.

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

How it works:

1. WebAssembly gives the host no notification when a `store` executes, and a compiled module
   cannot be modified. So the watchpoint has to be in the binary *before* the engine sees it.
2. The tool arms the watchpoint, then reloads the tab itself, because an arm only counts before the module is
   instantiated. Your module is rewritten as it streams past one
   mutable `i32` global, one import (`__wasmcheat.on_store` or `on_read`), one export
   (`__wc_arm`), and then:
   - **writes**: after every store instruction, `global.get flags; if (flags) { on_store(funcIndex) }`.
     A store leaves the stack empty, so appending is always safe.
   - **reads**: before every load, `call probe`, where the probe is `(i32) -> (i32)`:
     `global.get flags; if (flags) { on_read(addr + offset, funcIndex) }; addr`. The address is
     already on the stack, the probe hands it back unchanged, and no stack analysis is needed at
     all. One probe is generated per (function, memory offset) pair; the offset has to be baked
     in because compilers address globals as `i32.const 0; i32.load offset=1032`.
3. `funcIndex` is a constant per call site, which is the attribution: it names the function that
   performed the access. The page agent diffs the watched address on every callback and records
   the hit with the value before and after.
4. `wasmcheat_trace {action: "stop"}` removes the rewriting for the next reload, and nothing
   stays behind in the page.

Limits:

- The watchpoint needs a reload; a module that is already compiled can never be instrumented.
  When you arm a live page, the status says so instead of pretending.
- The gated check costs one global read and a branch per store, and one call per load, even when
  disarmed; while armed every access is a call into the page agent, which is slower than running
  free. Only the watchpoint you asked for is instrumented: `find_reads` leaves stores untouched
  and vice versa. That is the same trade Cheat Engine makes with a hardware breakpoint.
- `memory.copy` / `memory.fill` are reported as writes only: they take a length on top of the
  stack, so a `(i32) -> (i32)` probe would see the length instead of an address.
- Functions the module does not export appear as `wasm-function[12]`. That is all the identity
  the engine has; the index still lets you map it to a disassembly.
- On an unshared memory, atomic loads and stores (`0xFE`) and SIMD memory accesses (`0xFD`) are
  probed like any other; the four `v128.load*_lane` forms are walked but not probed, and listed in
  `unprobed`. Other atomics (read-modify-write, wait, notify) and shared memories make the rewriter
  refuse the module with `UNSUPPORTED` rather than rewrite it half-way. Element segments, start
  functions and indirect calls, everything Emscripten, Unity and clang emit today, are handled.

## Patching a function body

Hooks can only reach the surface a module exposes: imports and exports. Everything a module keeps to
itself (the damage routine, a cooldown, a check) has no seam to wrap, so the only way to switch it
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
- `target` is an export name, or `wasm-function[N]` for a function the module does not export;
  `wasmcheat_list_instances` shows both spellings next to each function it reports.
- The stub lives in the binary, so it also reaches callers that cached an export reference, which is
  the one thing a JS hook can never do.
- Patches persist across reloads (`sessionStorage`, per origin, exactly like arming a watchpoint) and
  stay until `remove` / `clear`, which reload the tab so the original body comes back. The extension
  keeps a copy per tab too, so a sandboxed game frame with no `sessionStorage` (every YouTube
  Playable) gets its patches back after the reload.
- `applied` is false until a module has been instantiated with the patch: a compiled module can never
  be edited. The tool waits for the instantiation the reload triggers, so `applied: true` means the
  code you are talking to is the code you patched.

The rewriter refuses to guess: a function with more than one result, or a result a constant cannot
produce (a `v128` or a reference), is reported as unsupported instead of being stubbed into a module
that no longer validates.

## Demo walkthrough

The demo is a small C clicker (`packages/demo-app/src/game.c`) whose state lives in linear memory:
lives at `0x400`, level at `0x404`, score at `0x408`, ore at `0x40C`.

```bash
npm run build
npm run demo        # serves http://127.0.0.1:4173/ and opens it
```

With the extension loaded and an agent connected, a session looks like this (`tabId` is optional:
without it a tool answers for the tab in front):

```
agent: wasmcheat_list_tabs {}
       → one tab, "Foundry", active: true
agent: wasmcheat_attach {}
       → instances: [w1, 131072 bytes]
agent: wasmcheat_scan { "instanceId": "w1", "type": "i32", "mode": "exact", "value": 75 }
       → scanId s1, 2 matches
       (press Mine a few times in the page between passes)
agent: wasmcheat_scan { "instanceId": "w1", "type": "i32", "mode": "changed", "scanId": "s1" }
       → 1 match
agent: wasmcheat_scan_results { "scanId": "s1" }
       → {"hits": [{"address": "w1:0x408", "value": 100}]}
agent: wasmcheat_write { "address": "w1:0x408", "type": "i32", "value": 999999 }
       → the score in the page changes, no reload
agent: wasmcheat_freeze { "action": "set", "address": "w1:0x400", "type": "i32", "value": 999 }
       → Hazard no longer takes lives
agent: wasmcheat_hook { "action": "add", "instanceId": "w1", "target": "export",
                        "name": "get_score", "body": "return ctx.call(args) + 1000000;" }
       → every painted score jumps by a million
agent: wasmcheat_audit { "limit": 20 }
       → the attach, the write, the freeze and the hook, with addresses and values
```

`window.__foundry` exposes `pause()`, `resume()` and `snapshot()` so a scan can target a value
that is not moving. The automated test does exactly that.

---

## Drive it from a shell

`scripts/wasmcheat-cli.mjs` is a one-shot MCP client, so you can poke a real site by hand:

```bash
node scripts/wasmcheat-cli.mjs tabs
node scripts/wasmcheat-cli.mjs attach 1234567
node scripts/wasmcheat-cli.mjs instances 1234567          # shorthand → {"tabId": …}
node scripts/wasmcheat-cli.mjs scan '{"tabId":1234567,"instanceId":"w1","type":"i32","mode":"exact","value":75}'
node scripts/wasmcheat-cli.mjs audit 40                   # last 40 audit entries
```

Every invocation spawns `dist/bin.js` itself, so the extension reconnects to the bridge each
time; set `WASMCHEAT_WAIT=40` to let it wait longer. Exit code 1 means the tool returned an
error (the message says which).

For a long session, `node scripts/hunt.mjs serve` keeps one MCP session open and `scripts/wc.mjs`
calls it in milliseconds. `--code file.js` sends a file as the `code` of `run_script` or `mod`, and
`--var NAME=JSON` passes it a parameter:

```bash
node scripts/wc.mjs run_script '{"tabId":1234567}' --code .agents/skills/mod-any-webapp/scripts/probe.js
node scripts/wc.mjs mod '{"tabId":1234567,"action":"add","name":"aim line"}' --code my-mod.js
```

Only one server can hold the bridge port. An agent's client starts its own, so stop it (or close the
agent) before `npm start`, `wasmcheat-cli.mjs` or `hunt.mjs serve`, and the other way round.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `WASMCHEAT_PORT` | `7331` | WebSocket port the extension dials. Must match the extension build. |
| `WASMCHEAT_HOST` | `127.0.0.1` | Bind address. Off loopback the server refuses to start unless `WASMCHEAT_PAIRING=off`, because pairing would hand the token to the network. |
| `WASMCHEAT_HOME` | `~/.wasmcheat` | Where `audit.jsonl` and `token` live. Created `0700`; both files are `0600`. |
| `WASMCHEAT_TOKEN` | read from `$WASMCHEAT_HOME/token` | Shared secret both ends prove they hold. Minted on first run; set to mode `0600` on every start. Setting it turns pairing off. |
| `WASMCHEAT_PAIRING` | `on` (`off` when `WASMCHEAT_TOKEN` is set) | `off` refuses pairing, so only a pasted token connects. |
| `WASMCHEAT_RECONNECT_GRACE_MS` | `8000` | How long a tool call waits for the extension to dial back in (or to finish its hello) before reporting `NO_AGENT`. MV3 suspends the service worker after ~30s idle, so the first call after a pause usually arrives mid-reconnect. |
| `WASMCHEAT_TOKEN_FILE` | `$WASMCHEAT_HOME/token` | Where the token is read and minted. |
| `WASMCHEAT_CLANG` | auto-detected | LLVM used to compile `packages/demo-app/src/game.c`. |

The shell clients read a few more: `WASMCHEAT_WAIT` (seconds `wasmcheat-cli.mjs` waits for the
extension, default 20), `WASMCHEAT_RPC_TIMEOUT` (milliseconds a call may take, default 900000),
`WASMCHEAT_SOCKET` (the socket `hunt.mjs serve` and `wc.mjs` share, default under the system temp
folder), and `WASMCHEAT_TAB` / `WASMCHEAT_TYPE` (defaults for `hunt.mjs`).

The extension dials port 7331 unless it was built with another (`WASMCHEAT_PORT=7400 npm run build`,
then start the server with the same value).
