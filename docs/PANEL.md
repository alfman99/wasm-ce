# The DevTools panel

The panel is the same bridge an MCP client talks to, with a human at the keyboard. Every call it
makes goes through the service worker's `wasmcheat.panel.call` family, which reuses the WebSocket
dispatcher, so frame routing, worker routing and the audit log behave identically. A panel is a
front end, not a separate implementation.

Open it with DevTools on the target tab → **WasmCheat**. The panel is bound to that tab: there is no
tab picker, because the tab you are inspecting is the tab you mean.

![The panel: target, workflow strip, scan, found list and the address tools](../docs/img/panel.png)

## Reading the header

| Element | Meaning |
| --- | --- |
| **This page** | The title and address of the tab the panel is bound to, with **Reload page** beside it for a game that started before WasmCheat did. `No page to analyze` means DevTools is open on a page WasmCheat cannot run in (`chrome://`, an extension page). |
| **Now** | `Foundry · w1 · 0x408`. Tab, then instance, then the address in the forms. Updates as you click. It answers "what am I about to write to?" |
| `agent` pill | What the page runs: `1 wasm module`, `3 wasm modules`, or `no wasm`; ` · scripts blocked` is added when the page's CSP forbids hook bodies (use a declarative fallback). |
| `bridge` pill | The optional MCP server: `MCP off` (neutral: the panel does not need it), `MCP live`, `MCP needs a token` or `MCP token refused`. The token field appears only for the last two. |
| Steps strip | `1 Scan for a value`, `2 Narrow it down`, `3 Change it`. The current step is outlined, so the strip tells you where you are rather than listing three links. |
| **Help** / **Theme** | The same help sheet as <kbd>?</kbd>, and a light/dark switch that is remembered. |

The three chips under the header are the workflow: **1 Scan for a value**, **2 Narrow it down**,
**3 Change it**. Each jumps to the card that does that job.

There is nothing to set up, attach or approve. Opening the panel on a tab is the choice: the page
agent was injected when the page loaded, so the panel lists the wasm on its own and fills the Scan
card's Instance field. A page that was open before WasmCheat was installed is reloaded once, and the
panel says so.

When the page has no WebAssembly the panel shows **Nothing to analyze in this tab** instead of the
scan cards, with **Reload page** and **Why is it empty?** (which runs Diagnose). It keeps watching:
a game that loads its wasm on a click switches the panel to the scan cards by itself.

When the only WebAssembly is a physics engine (Ammo.js, Box2D, Rapier, Havok, Jolt, PhysX), a note
above the scan cards says so: the game is JavaScript (PlayCanvas, three.js, Babylon.js), so its score
and coins are in no memory the panel can scan. Only the physics (bodies, forces, collisions) is.

## Cards

The first screen is the loop: Found and Scan side by side, Text scan, then the things you keep
(Freeze, Watch, Bookmarks). Everything else (Memory view, Read and write, Instances, Watchpoints,
Patches, Hooks, Pointers, Speed hack, Workers, Saved scans, Audit and the raw console) is one click
away under **More tools**, which is collapsed until you need it. The palette opens it for you when
you jump to one of its cards.

Every card is a set of forms over one page method; the MCP column names the tool that does the same
thing, so a human and an agent are never using different mechanisms.

Nothing on the first screen needs a refresh button. Four times a second the panel reads the Found
list, the picked address, the freezes, watches and bookmarks, and the memory view while More tools
is open. Rows update in place (the same element keeps its position and its click), lists that are
empty are asked once a second, and all of it stops while another DevTools tab is in front. A tick
is a handful of calls of 2 to 5 ms each. A reload of the page clears the Found list with a sentence
saying so, because the scan lived in the page that went away.

| Card | What it does | MCP tool |
| --- | --- | --- |
| **Reload page** | Reloads the tab so the agent is in place before the game starts, then reports how many wasm modules it found (or quotes Diagnose). The panel does the first start on its own. | `wasmcheat_attach` with `reload` |
| **Instances** | Wasm instances in the target: id, exports, memory size, `page` or `worker`, `importPatchability`. | `wasmcheat_list_instances` |
| **Diagnose** | Why the instance list is empty: `WebAssembly.*` call counts, iframes (cross-origin flagged), canvases, `.wasm` URLs in the HTML, `evalAllowed`. | `wasmcheat_diagnose` |
| **Scan** | Value, type, mode, the instance, plus a **More options** fold holding the byte range, alignment and result limit (the defaults are right until a scan is too slow or too broad). The upper bound appears only for `between`, and the value is labelled optional for the delta modes. **First Scan** starts a list; **Next Scan** narrows it, the filled button is always the next step, and <kbd>Enter</kbd> in a value field runs it. After the first scan, **Changed**, **Stayed the same**, **Went up** and **Went down** narrow in one click. **First Scan** with Value empty is an unknown-value scan: every address is a candidate (kept as a copy of memory, so nothing is cut off) until those buttons narrow it. | `wasmcheat_scan`, `wasmcheat_scan_results`, `wasmcheat_scan_drop` |
| **Text scan** | ASCII, UTF-8 or a hex byte pattern, case-sensitive or not. | `wasmcheat_scan_text` |
| **Found** | The current candidate list, up to 100 rows, read live. **Value** is memory now, **Previous** the value at the last scan, and a value that moved since is marked in the accent: that is what tells you to narrow with changed or unchanged. Click an address and an editor opens under it with the current value: **Write** (or <kbd>Enter</kbd>) changes it and prints `before -> after`; **Freeze** holds it at the typed value and turns into **Unfreeze**. The click also fills every other form and jumps the memory view. | `wasmcheat_scan_results`, `wasmcheat_write`, `wasmcheat_freeze` |
| **Read and write** | One value, N values, or raw hex bytes; **Write** is audited with old and new value. | `wasmcheat_read`, `wasmcheat_write` |
| **Freeze** | Holds an address at a value with a 16 ms page-side timer. The list is live; each row has its own Clear. | `wasmcheat_freeze` |
| **Watch** | Records changes to an address. The list shows each value now; **Show changes** drains the recorded changes (200 per watch), so it is a button and never automatic: an MCP agent may be reading the same buffer. | `wasmcheat_watch` |
| **Memory view** | Hex dump, 16 bytes per row. **Follow pointer** reads a u32 at the address and jumps there. | `wasmcheat_read` with `length` |
| **Watchpoints** | Which function wrote or read an address. Rewrites the module and reloads the tab, because a store cannot be observed after compilation. | `wasmcheat_find_writes`, `wasmcheat_find_reads`, `wasmcheat_trace` |
| **Patches** | Replace a function body (`stub` returns immediately, `empty` writes no instructions). | `wasmcheat_patch` |
| **Hooks** | JavaScript wrapper around an export or import: inspect `args`, rewrite them with `ctx.call`, replace the result. Imports apply at the next instantiation. | `wasmcheat_hook` |
| **Script** | Runs JavaScript in the game's frame, even a cross-origin iframe, and shows its value. Code pasted from the DevTools console works as it is, with no frame to pick; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> runs it. Every run is logged with its code. | `wasmcheat_run_script` |
| **Pointers** | Multi-level pointer chains: base address plus offsets, shortest first. Resolve a pasted path back to a live address. | `wasmcheat_pointer_scan`, `wasmcheat_pointer_resolve` |
| **Speed hack** | Scales `performance.now`, `Date.now` and `requestAnimationFrame` in the page and in every worker. `0` stops time. | `wasmcheat_speed` |
| **Workers** | Wasm inside Web Workers, including a worker started by a worker. | `wasmcheat_list_workers` |
| **Saved scans** | Candidate lists kept in the page's `sessionStorage`, so a reload does not lose the narrowing. | `wasmcheat_saved` |
| **Bookmarks** | Labelled addresses kept in `localStorage`, with a type so each row shows its value now. | `wasmcheat_bookmark` |
| **Audit** | Every change made through the extension, from the panel or from an agent. | `wasmcheat_audit` |
| **Raw console and events** | Any page method with JSON parameters, plus a live log of bridge and page events with **Pause**. | None |

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
the forms"; the panel fills it in for you. Inside workers the same shape carries the realm:
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
| Panel says `No page to analyze` | DevTools must be open on a web page; extension pages and `chrome://` tabs cannot be inspected |
| `Nothing to analyze in this tab` | The page has loaded no WebAssembly yet. Start the game if it waits for a click; if it was already running before WasmCheat, press **Reload page** |
| Note: "This page's WebAssembly is … a physics engine" | The game logic is JavaScript. A scan for the score or coins finds nothing; only physics values are in this memory |
| `NO_AGENT` in an output block | Press **Reload page** |
| Instances empty | **Why is it empty?** (Diagnose); all-zero call counts mean the module was compiled before the agent, so press **Reload page** |
| A hook call returns `HOOK_EVAL_BLOCKED` | The page forbids `new Function`; use a declarative fallback |
| `freeze` does not stick | The app rewrites the value outside the 16 ms pass, or the address is a copy; try the mirror address a scan also found |
| Watchpoint status says `installed: false` | The module was already compiled; the panel reloads to arm it, so retry and let the reload finish |
| Everything works but the audit is short | The log records mutations (writes, freezes, hooks, patches, scans, bookmarks, speed, trace, reloads), not reads |
