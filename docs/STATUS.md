# Status: what works, what is known-broken, what is next

Last verified: `typecheck` 0 errors, `vitest` 99 passed, `playwright` 13 passed / 2 skipped (23.8 s).

## Proven end to end (real browser, real tab)

- Attach with human approval; per-site grant; audit log of attaches, scans, writes, freezes, hooks, traces.
- Scan / narrow (exact, comparison, delta, text) and read / write / freeze / watch on page-hosted wasm.
- Live Playables game ("My Mini Mart", cross-origin iframe): found the coin counter as **i64**, froze two
  mirrored copies at 99,999,999 and the game showed it. See the "two facts" section of the README for why
  i32 scans missed it.
- Write watchpoints (`find_writes`), read watchpoints (`find_reads`), function patches, pointer scan,
  all as MCP tools.
- `instanceId: "latest"` resolves at call time, so ids survive a re-instantiation.

## Implemented but not proven in a browser

- **Worker-hosted wasm**: the `Worker` constructor is wrapped and each worker bootstraps a worker-scope
  agent through a blob; ids carry their owner (`k1-1`, `k1-s1`). Covered by `tests/unit/worker.test.ts`.
  `tests/e2e/demo.spec.ts` has the browser case quarantined with `test.skip` — it hangs the run, which
  means the blob bootstrap has a bug the unit test cannot see.
- **Atomics / SIMD probing**: `0xFE` loads/stores and `0xFD` v128 memory ops are probed; v128 lane loads
  are reported through `unprobed[]` instead of probed. Read-modify-write atomics throw `UNSUPPORTED`.

## Known broken or missing (in the order worth fixing)

1. **Cross-origin iframe e2e is skipped.** It regressed when the bridge port moved into
   `chrome.storage` and fails in under a second; subframe routing itself works (proven on the live tab).
2. **Bridge has no authentication.** Anything on localhost can connect to `ws://127.0.0.1:7331` and drive
   an approved tab, and the newest connection wins. Needs a token the popup shows and the MCP server
   passes.
3. **Audit is incomplete.** `hook enable/disable`, `watch add/remove`, scan narrowing and re-instantiation
   are not recorded; only the mutating calls that were easy to reach are.
4. **Service-worker suspension** costs ~30 s of dropouts. Routing state now survives it, but the
   connection still has to come back on the alarm; a long-running agent will see `NO_AGENT` errors that
   are retryable rather than fatal.
5. **Scan sessions do not survive a page reload.** Ids self-heal through `latest`, sessions cannot be
   restored: a reload means starting the scan over.

## Operating notes

- Verify a write with a read, not with the screen: games repaint their HUD when *they* change a value, so
  a frozen value can be correct in memory while the display lags.
- Coins, currencies and scores in engine-built games are usually `i64` or `f64`, and often mirrored in
  two places. Scan, narrow to the candidates, freeze them all, then confirm by read.
- Keep the popup open during a session; it pins the service worker.
