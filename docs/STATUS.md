# Status: what works, what is known-broken, what is next

Last verified from a clean tree (`rm -rf node_modules packages/*/dist`, `npm ci`):

- `npm run build` 0 errors, `npm run typecheck` 0 errors
- `npx vitest run` **121 passed** (13 files)
- `npx playwright test` **19 passed, 0 skipped** (17.6 s, real Chromium, real extension, no mocks)

## Proven end to end (real browser, real tab)

- Attach with human approval, granted per tab **and site**; every mutation ends up in one audit
  funnel (scan begin/narrow/results/drop, read, write, freeze, watch, hook, patch, trace, attach,
  detach, saved lists), visible from MCP (`wasmcheat_audit`), the DevTools panel and
  `$WASMCHEAT_HOME/audit.jsonl`.
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
- Cross-origin iframes: `all_frames`, per-frame relay, frame resolution by instance count, e2e
  against `framed.html` (a genuinely cross-origin `localhost` vs `127.0.0.1` embed).
- DevTools panel (`packages/extension/dist` → DevTools → WasmCheat): every tool as a form, a raw
  RPC console, a live event log and a live audit view, sharing one dispatcher with the WebSocket.
- Live Playables game ("My Mini Mart", cross-origin iframe): found the coin counter as **i64**, froze
  two mirrored copies at 99,999,999 and the game showed it. See "Two WebAssembly facts" in the
  README for why i32 scans missed it.
- Bridge authentication: token minted into `$WASMCHEAT_HOME/token` (or `WASMCHEAT_TOKEN`), required
  in `bridge.hello`, wrong token closed with `1008 bad bridge token`.
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

## Known missing (in the order worth fixing)

1. **Memory viewer** — the panel shows typed reads at an address, not a scrolling hex dump with
   follow-pointer navigation. Cetus has one; this is the largest remaining UI gap.
2. **Speed hack** — Cetus scales `performance.now` / `Date.now` in the MAIN world. Not implemented;
   it is a page-realm trick rather than a memory tool, so it needs its own approval story.
3. **Worker threads spawned from a worker**, and wasm inside a nested worker: only the first hop is
   wrapped (each worker agent installs the same wrapper, so nested workers normally work — but no
   e2e proves it).

## Operating notes

- Verify a write with a read, not with the screen: games repaint their HUD when *they* change a value,
  so a frozen value can be correct in memory while the display lags.
- Coins, currencies and scores in engine-built games are usually `i64` or `f64`, and often mirrored in
  two places. Scan, narrow to the candidates, freeze them all, then confirm by read.
- Keep the popup or the DevTools panel open during a long session; either one pins the service worker.
- Never arm a watchpoint and reload by hand: `wasmcheat_find_writes` reloads for you, and the arm
  intent is persisted in `sessionStorage` so the agent re-arms at `document_start`.
- A scan is a snapshot of a moment: pause the game (or use delta modes) before trusting a hit list.
