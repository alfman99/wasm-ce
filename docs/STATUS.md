# Status: what works, what is known-broken, what is next

Last verified from a clean tree (`rm -rf node_modules packages/*/dist`, `npm ci`):

- `npm ci` clean, `npm run build` 0 errors, `npm run typecheck` 0 errors
- `npx vitest run` **123 passed** (13 files)
- `npx playwright test` **22 passed, 0 skipped** (~22 s, real Chromium, real extension, no mocks)

## Proven end to end (real browser, real tab)

- Attach with no approval step: the panel is bound to its tab and every tool defaults to the tab in
  front. Every **mutation** ends up in one audit funnel. The extension reports these page methods from `callTab` (`describeAction` in
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
  pointer** (reads a u32 and jumps), and clicking any address — a scan hit, a bookmark, a watch
  event — jumps the dump to it. Proven in the panel e2e.
- Cross-origin iframes: `all_frames`, per-frame relay, frame resolution by instance count, e2e
  against `framed.html` (a genuinely cross-origin `localhost` vs `127.0.0.1` embed).
- DevTools panel (`packages/extension/dist` → DevTools → WasmCheat): every tool as a form, a raw
  RPC console, a live event log and a live audit view, sharing one dispatcher with the WebSocket.
- Live Playables game ("My Mini Mart", cross-origin iframe): found the coin counter as **i64**, froze
  two mirrored copies at 99,999,999 and the game showed it. See "Two WebAssembly facts" in the
  README for why i32 scans missed it.
- Bridge authentication: token minted into `$WASMCHEAT_HOME/token` (or `WASMCHEAT_TOKEN`), required
  in `bridge.hello`, wrong token closed with `1008 bad bridge token`. The extension pairs for it on
  first connect (`bridge.pair`, answered only while no live socket is authenticated); pairing is off
  when the token is pinned or `WASMCHEAT_PAIRING=off`. A paired token is stored with its source, so
  the popup/panel can say `paired` instead of asking for a paste.
- Attaching to a page that predates the agent reloads that tab once, on its own, and reports
  `autoReloaded` so an agent knows every address it had is stale.
- Service-worker suspension: the bridge state survives it, tool calls wait out the reconnect
  (`WASMCHEAT_RECONNECT_GRACE_MS`, default 8000), and `page.hello` retries when a document is being
  replaced by a reload.

## Implemented, with honest limits

- **Atomics / SIMD probing**: `0xFE` loads/stores and `0xFD` v128 memory ops are probed; v128 lane
  loads are reported through `unprobed[]` instead of probed. Read-modify-write atomics throw
  `UNSUPPORTED`.
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

1. **SharedArrayBuffer / `pthread` threads** — worker realms themselves are reached with
   `postMessage`, which every page has. What is untested is a page that shares one memory between
   threads: `SharedArrayBuffer` requires cross-origin isolation (COOP/COEP) and a pthread build, and
   neither the demo nor the suite exercises it. Single-realm atomics loads/stores are probed.
2. **Speed hack scope** — `performance.now`, `Date.now` and `requestAnimationFrame` are wrapped in the
   page realm *and* in every worker realm (the scale is forwarded down the chain), so a worker game
   speeds up too. A game that measures time with `performance.timeOrigin` arithmetic, or with a
   `Date.now` captured before the agent installed, keeps the real clock.

## Operating notes

- Verify a write with a read, not with the screen: games repaint their HUD when *they* change a value,
  so a frozen value can be correct in memory while the display lags.
- Coins, currencies and scores in engine-built games are usually `i64` or `f64`, and often mirrored in
  two places. Scan, narrow to the candidates, freeze them all, then confirm by read.
- Keep the popup or the DevTools panel open during a long session; either one pins the service worker.
- Never arm a watchpoint and reload by hand: `wasmcheat_find_writes` reloads for you, and the arm
  intent is persisted in `sessionStorage` so the agent re-arms at `document_start`.
- A scan is a snapshot of a moment: pause the game (or use delta modes) before trusting a hit list.
