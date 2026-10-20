# Status: what works, what is known-broken, what is next

Last verified from a clean tree on 2026-10-20 (`rm -rf packages/*/dist`, `npm ci`):

- `npm ci` clean, `npm run build` 0 errors, `npm run typecheck` 0 errors
- `npx vitest run` **159 passed** (16 files)
- `npx playwright test` **26 passed, 0 skipped** (~35 s, real Chromium, real extension, no mocks)
- `npm audit --omit=dev` 0 vulnerabilities. The full audit flags 6 in test tooling only (vitest 2,
  the esbuild inside vite); fixing them needs a vitest major upgrade.

## Proven end to end (real browser, real tab)

- No attach step in the panel: it starts the page agent on the tab it is opened on, shows
  **Nothing to analyze in this tab** when the page has no WebAssembly, and switches to the scan cards
  when a module appears. Every MCP tool defaults to the tab in front, with no approval step. Every **mutation** ends up in one audit funnel. The extension reports these page methods from `callTab` (`describeAction` in
  `packages/extension/src/sw.ts`): `page.write`, `page.freeze.set|clear`, `page.watch.add|remove`,
  `page.scan.begin|next|drop|text`, `page.pointer.scan`, `page.hook.add|setEnabled|remove`,
  `page.patch.add|remove|clear`, `page.trace.arm|stop|clear`, `page.bookmark.add|remove|clear`,
  `page.speed.set`, plus `ext.reload`. Attach, detach and saved scan lists
  (`wasmcheat_saved` save / open / delete) are recorded by the MCP server, which is the only writer
  for them.
  All of it is visible from MCP (`wasmcheat_audit`), the DevTools panel and
  `$WASMCHEAT_HOME/audit.jsonl`. Reads, `scan_results`, `pointer_resolve`, listing calls and watch
  polls are deliberately not logged: they change nothing, and logging them would bury the writes in
  noise.
- Live panel: the Found list (with the value at the last scan beside the value now), the picked
  address, freezes, watches and bookmarks update four times a second, in place, and stop while the
  panel is hidden (e2e: a hit's value moves with no button press and its row is the same element).
- A game frame that instantiates after the panel opened is found on its own: a frame pick with no
  wasm is re-checked every 2 s (e2e: cross-origin iframe instantiating after 4 s). A page that was
  open before WasmCheat and already runs a game (a canvas or a `.wasm` reference, no instance the
  injected agent can see) is reloaded once with a notice; a plain page is not.
- Real sites (2026-10-20): WASM-4 carts on wasm4.org found and scanned with no step and no error;
  the Godot web .NET prototype (a threaded build whose threads share one 218 MiB memory) is found,
  the page's instance is picked on its own, an exact scan takes ~250 ms, an unknown-value scan
  ~150 ms and its first narrowing ~380 ms. Pages that load their engine on a click (the Godot web
  editor, js-dos) show "Nothing to analyze" until then, as intended.
- Scan speed on 256 MiB (Node, M-series): exact i32 ~80 ms, f32 ~120 ms, i64 ~45 ms, greater i32
  ~95 ms, unaligned (alignment 1) ~260 ms. Each type and mode family has its own loop; a unit test
  pins every loop to the reference predicate for every type, mode and alignment.
- Unknown-value scans: First Scan with no value keeps every aligned position as a bitmap plus a copy
  of the bytes (256 MiB: 61 ms), and a movement pass narrows against it (~210 ms) until at most a
  million candidates are left, when it becomes a plain list. Unit and e2e tested. Saving such a scan
  before its first narrowing is refused with a sentence.
- Scan / narrow (13 modes: exact, not-equal, less, greater, less-or-equal, greater-or-equal,
  between, changed, unchanged, increased, decreased, increased-by, decreased-by), text scan
  (ascii / utf8 / hex bytes), read, write, freeze, watch.
- Watchpoints and instrumentation: `find_writes`, `find_reads`, `wasmcheat_trace`, function-body
  patches (`wasmcheat_patch`), pointer scan/resolve.
- Saved scan lists that survive a page reload (`wasmcheat_saved`), and a named address list
  (`wasmcheat_bookmark`, per site, in `localStorage`) that survives a reload and reads back the value
  it named.
- Web Workers: a worker created during page start-up is captured, listed
  (`wasmcheat_list_workers`), scanned, written to, and the write shows up in the worker's own
  published state (e2e).
- Nested workers: a worker started from inside a worker is captured too (id `k1n1`), its wasm is
  listed, written and scanned through the chain, proven by `nested.html` in the e2e suite.
- Speed hack (`wasmcheat_speed`): scales `performance.now` / `Date.now` / `requestAnimationFrame` in
  the page realm and in every worker realm (0–20x, and 0 freezes the clock); e2e measures score
  growth at 4x against 1x, at 0, and after reset; a unit test proves the scale reaches workers.
- Memory viewer in the DevTools panel: 16 bytes per row, pan earlier/later, ASCII gutter, **Follow
  pointer** (reads a u32 and jumps), and clicking any address (a scan hit, a bookmark, a watch
  event) jumps the dump to it. Proven in the panel e2e.
- Cross-origin iframes: `all_frames`, per-frame relay, frame resolution by instance count, e2e
  against `framed.html` (a genuinely cross-origin `localhost` vs `127.0.0.1` embed).
- DevTools panel (`packages/extension/dist` → DevTools → WasmCheat): every tool as a form, a raw
  RPC console, a live event log and a live audit view, sharing one dispatcher with the WebSocket.
- Live Playables game ("My Mini Mart", cross-origin iframe): found the coin counter as **i64**, froze
  two mirrored copies at 99,999,999 and the game showed it. See "Three WebAssembly facts" in the
  README for why i32 scans missed it.
- Bridge authentication, mutual: token minted into `$WASMCHEAT_HOME/token` (or `WASMCHEAT_TOKEN`) and
  never sent after pairing. The server opens with `bridge.challenge` (a nonce), the extension proves
  the token in `bridge.hello` (its nonce plus an HMAC-SHA256 of both), a bad proof is closed with
  `1008 bad bridge token`, and the server proves it back in `bridge.welcome`. Until that welcome
  checks out the extension runs no request and sends no event, so a program holding the port while
  the server is down gets nothing (unit-tested against the real `sw.ts`). The extension pairs for it on
  first connect (`bridge.pair`, refused until the authenticated socket has closed); pairing is off
  when the token is pinned or `WASMCHEAT_PAIRING=off`. A web-page `Origin` is refused at the
  upgrade, and an unauthenticated socket can neither answer requests nor send events or audit lines. A paired token is stored with its source, so
  the popup/panel can say `paired` instead of asking for a paste.
- Attaching to a page that predates the agent reloads that tab once, on its own, and reports
  `autoReloaded` so an agent knows every address it had is stale.
- No errors while the MCP server is down: the service worker probes the port with a silent `fetch`
  and dials the WebSocket only when something answers, because Chrome logs every refused WebSocket
  as an extension error. `tests/e2e/quiet.spec.ts` asserts zero extension and console errors.
- Service-worker suspension: the bridge state survives it, tool calls wait out the reconnect
  (`WASMCHEAT_RECONNECT_GRACE_MS`, default 8000), and `page.hello` retries when a document is being
  replaced by a reload.

## Implemented, with honest limits

- **Worker instances (`k1-…`) have no storage.** A worker realm has no `sessionStorage` or
  `localStorage`, so saving or opening a saved scan, adding a bookmark, and `find_writes` /
  `find_reads` on a worker instance return `UNSUPPORTED` with a sentence saying why, instead of
  failing silently. Scan, read, write, freeze, watch and the speed hack work in workers.
- **A sandboxed frame has no `sessionStorage`** (YouTube Playables runs every game in one), so saved
  scans there return `UNSUPPORTED`. Patches and watchpoints still survive the reload: the extension
  keeps a copy per tab and hands it back to the new frame.
- **A freeze loses to a value the app writes every frame.** It rewrites every 16 ms; PlayCanvas, for
  one, pushes its gravity into Bullet before each physics step, so a frozen gravity is overwritten
  before it is read. Find the writer with `find_writes` and switch it off with a patch instead.
- **Shared memories are refused by the rewriter**, so watchpoints and patches do not reach an
  Emscripten `-pthread` build. Typed function references (`ref null $t` locals, GC types) are refused
  with `UNSUPPORTED` rather than rewritten.

- **Atomics / SIMD probing**: `0xFE` loads/stores and `0xFD` v128 memory ops are probed; v128 lane
  loads are reported through `unprobed[]` instead of probed. Read-modify-write atomics throw
  `UNSUPPORTED`.
- **Watchpoints watch every instrumented instance**: each instantiation made while armed gets its
  own callback closure, so a helper module instantiated after the game reports into its own memory
  and function names. Hits carry their instance in `address` and `functions[].instanceId`;
  `status.instanceId` is the instance the address names, else the first instrumented one.
- **Synchronous loads** (`new WebAssembly.Module` + `new WebAssembly.Instance`, wasm-bindgen's
  `initSync`) are hashed, patched and watched: the rewritten bytes compile synchronously and the app
  keeps its own `Module` object. A module whose bytes the agent never saw (compiled before it
  installed, or posted in from another realm) runs unpatched, and the trace `note` says so.
- **Import hooks** apply at the next instantiation, never to a running instance (WebAssembly binds
  imported functions at instantiation). `importPatchability` says so instead of pretending.
- **Export hooks / patches** only reach callers that read `instance.exports.x` per call. Emscripten
  glue caches exports in a local (`_get_score = wasmExports['get_score']`), which is why the demo
  ships a hand-written loader; the README documents this.
- **`evalAllowed: false`** (strict CSP, e.g. YouTube): free-form hook bodies are refused with
  `HOOK_EVAL_BLOCKED`; declarative fallbacks (`replace-return`, `offset-result`) still work.
- **Frame pick is a heuristic**: the service worker probes frames with `page.diagnose` and takes the
  one holding the most instances. `wasmcheat_attach {frameId}` overrides it.
- **The memory viewer is read-only**: it dumps and navigates, and writes go through the typed write
  form (which returns `before -> after` and is audited). That split is deliberate, not missing.

## Environment limits (not gaps in the tool)

1. **SharedArrayBuffer / `pthread` threads.** Worker realms themselves are reached with
   `postMessage`, which every page has. What is untested is a page that shares one memory between
   threads: `SharedArrayBuffer` requires cross-origin isolation (COOP/COEP) and a pthread build, and
   neither the demo nor the suite exercises it. Single-realm atomics loads/stores are probed.
2. **Speed hack scope.** `performance.now`, `Date.now` and `requestAnimationFrame` are wrapped in the
   page realm *and* in every worker realm (the scale is forwarded down the chain), so a worker game
   speeds up too. A game that measures time with `performance.timeOrigin` arithmetic, or with a
   `Date.now` captured before the agent installed, keeps the real clock.

## Operating notes

- Verify a write with a read, not with the screen: games repaint their HUD when *they* change a value,
  so a frozen value can be correct in memory while the display lags.
- Coins, currencies and scores in engine-built games are usually `i64` or `f64`, and often mirrored in
  two places. Scan, narrow to the candidates, freeze them all, then confirm by read.
- Keep the popup or the DevTools panel open during a long session; either one pins the service worker.
  Without them, a 30-second alarm wakes the worker and redials the bridge.
- Never arm a watchpoint and reload by hand: `wasmcheat_find_writes` reloads for you, and the arm
  intent is persisted in `sessionStorage` so the agent re-arms at `document_start`. The extension
  sends the arm only to the first document after it, on the same site, and forgets it after that,
  on stop or clear, or when the page refuses it.
- A scan is a snapshot of a moment: pause the game (or use delta modes) before trusting a hit list.
