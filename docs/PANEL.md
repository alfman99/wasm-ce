# The DevTools panel

The panel is the same bridge an MCP client talks to, with a human at the keyboard. Every call it
makes goes through the service worker's `wasmcheat.panel.call` family, which reuses the WebSocket
dispatcher — so the approval gate, frame routing, worker routing and audit log behave identically.
A panel is a front end, not a bypass.

Open it with DevTools on the target tab → **WasmCheat**. The panel is bound to that tab; switch tabs
and you are looking at the same page you started from.

![The panel: target, workflow strip, scan, found list and the address tools](../docs/img/panel.png)

## Reading the header

| Element | Meaning |
| --- | --- |
| **Target** | The tab the panel is attached to (`tab 1310636703 · Foundry`). `no tab attached` means the panel has not been pointed at anything yet. |
| **Now** | `Foundry · w1 · 0x408`. Tab, then instance, then the address in the forms. Updates as you click. It answers "what am I about to write to?" |
| `bridge` pill | The extension's WebSocket to the MCP server. `live`, `offline (retrying)`, `token refused`, `no token saved`. |
| `approval` pill | `none`, `pending`, `granted`, `revoked` for this tab and site. |
| `agent` pill | Whether the page agent is answering in this tab. |
| **Help** / **Theme** | The same help sheet as <kbd>?</kbd>, and a light/dark switch that is remembered. |

The three chips under the header are the workflow: **1 Pick a tab**, **2 Scan for a value**,
**3 Change it**. Each jumps to the card that does that job.

## Cards

Every card is a set of forms over one page method; the MCP column names the tool that does the same
thing, so a human and an agent are never using different mechanisms.

| Card | What it does | MCP tool |
| --- | --- | --- |
| **Tabs** | Lists tabs with approval state, frames and whether an agent is attached. Click a row to select it. | `wasmcheat_list_tabs` |
| **Attach / Reload & attach / Approve / Deny / Detach / Revoke** | The approval gate. Attach asks once per tab and site; the same-site reload keeps the grant. | `wasmcheat_attach`, `wasmcheat_detach`, `wasmcheat_approval_status` |
| **Instances** | Wasm instances in the target: id, exports, memory size, `page` or `worker`, `importPatchability`. | `wasmcheat_list_instances` |
| **Diagnose** | Why the instance list is empty: `WebAssembly.*` call counts, iframes (cross-origin flagged), canvases, `.wasm` URLs in the HTML, `evalAllowed`. | `wasmcheat_diagnose` |
| **Scan** | Type, mode, value, optional second value for `between`, alignment, byte range, max hits. **First Scan** starts a list; **Next Scan** narrows it. | `wasmcheat_scan`, `wasmcheat_scan_results`, `wasmcheat_scan_drop` |
| **Text scan** | ASCII, UTF-8 or a hex byte pattern, case-sensitive or not. | `wasmcheat_scan_text` |
| **Found** | The current candidate list. Click an address to fill every form and jump the viewer. | `wasmcheat_scan_results` |
| **Reads / writes** | One value, N values, or raw hex bytes; **Write** is audited with old and new value. | `wasmcheat_read`, `wasmcheat_write` |
| **Freeze** | Holds an address at a value with a 16 ms page-side timer. List and clear. | `wasmcheat_freeze` |
| **Watch** | Records changes to an address; **Poll** drains the buffer (200 events per watch). | `wasmcheat_watch` |
| **Memory View** | Hex dump, 16 bytes per row. **Follow pointer** reads a u32 at the address and jumps there. | `wasmcheat_read` with `length` |
| **Watchpoints** | Which function wrote or read an address. Rewrites the module and reloads the tab, because a store cannot be observed after compilation. | `wasmcheat_find_writes`, `wasmcheat_find_reads`, `wasmcheat_trace` |
| **Patches** | Replace a function body (`stub` returns immediately, `empty` writes no instructions). | `wasmcheat_patch` |
| **Hooks** | JavaScript wrapper around an export or import: inspect `args`, rewrite them with `ctx.call`, replace the result. Imports apply at the next instantiation. | `wasmcheat_hook` |
| **Pointers** | Multi-level pointer chains: base address plus offsets, shortest first. Resolve a pasted path back to a live address. | `wasmcheat_pointer_scan`, `wasmcheat_pointer_resolve` |
| **Speed hack** | Scales `performance.now`, `Date.now` and `requestAnimationFrame` in the page and in every worker. `0` stops time. | `wasmcheat_speed` |
| **Workers** | Wasm inside Web Workers, including a worker started by a worker. | `wasmcheat_list_workers` |
| **Saved scans** | Candidate lists kept in the page's `sessionStorage`, so a reload does not lose the narrowing. | `wasmcheat_saved` |
| **Bookmarks** | Labelled addresses kept in `localStorage`. | `wasmcheat_bookmark` |
| **Audit** | Every change made through the extension, from the panel or from an agent. | `wasmcheat_audit` |
| **Raw console and events** | Any page method with JSON parameters, plus a live log of bridge and page events with **Pause**. | — |

## Shortcuts

| Keys | Action |
| --- | --- |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd> | Open the palette: every card, filterable, arrow keys, <kbd>Enter</kbd> to jump |
| <kbd>?</kbd> | Help sheet |
| <kbd>T</kbd> | Light / dark |
| <kbd>Esc</kbd> | Close the palette or the help sheet |

Shortcuts are ignored while you are typing in a field, so `t` in a value box is just a `t`.

## Addresses

`w1:0x408` is instance `w1` at byte offset `0x408`. `0x408` alone means "the instance currently in
the forms" — the panel fills it in for you. Inside workers the same shape carries the realm:
`k1-1:0x408` is instance 1 of worker `k1`, and `k1n1-1:0x408` is a worker started by `k1`.

## Habits worth keeping

- **Read back after writing.** The page may format, clamp or cache what it displays. The memory is
  the truth; the HUD is a drawing of it.
- **Try `i64` and `f64` early.** A currency that will not match as `i32` is usually 64-bit.
- **Scanning a moving value needs a pause.** Use the page's own pause if it has one, or freeze the
  value first.
- **Reload invalidates instance ids** (`w1` becomes `w2`) and scan sessions. Save the list first.
- **Keep the popup or panel open** while an agent works: an idle service worker can be suspended by
  Chrome, and an open extension page pins it.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Panel says `no tab attached` | Click the row in **Tabs**; DevTools must be open on the tab you want |
| `NEED_APPROVAL` in an output block | Press **Approve**, or approve in the popup |
| `NO_AGENT` | **Detach**, then **Attach**; if it repeats, **Reload & attach** |
| Instances empty | **Diagnose**; all-zero call counts mean the module was compiled before the agent — reload and attach |
| A hook call returns `HOOK_EVAL_BLOCKED` | The page forbids `new Function`; use a declarative fallback |
| `freeze` does not stick | The app rewrites the value outside the 16 ms pass, or the address is a copy; try the mirror address a scan also found |
| Watchpoint status says `installed: false` | The module was already compiled; the panel reloads to arm it, so retry and let the reload finish |
| Everything works but the audit is short | The log records mutations (writes, freezes, hooks, patches, scans, bookmarks, speed, trace, reloads), not reads |
