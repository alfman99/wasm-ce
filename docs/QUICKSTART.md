# Quick start

From a clean clone to changing a value in a WebAssembly game, then handing the same job to an agent,
in about five minutes. Every command below runs from the repository root.

The zip on the [latest release](https://github.com/alfman99/wasm-ce/releases/latest) holds the
extension only, so it gives you the panel but no MCP server for an agent. This guide builds both
from source.

## 1. Build it

You need Node 22 or newer and git.

```bash
git clone https://github.com/alfman99/wasm-ce.git && cd wasm-ce
npm install
npm run build
```

`npm run build` compiles the protocol, the wasm instrumenter, the page agent, the extension, the MCP
server and the demo.
It also compiles `packages/demo-app/src/game.c` to `packages/demo-app/prebuilt/game.wasm` when it
finds a clang that can target wasm; otherwise the committed `.wasm` is used unchanged.

## 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → choose `packages/extension/dist`.

That folder is the extension root: it holds `manifest.json`, the service worker, the page agent and
the DevTools panel. Reload the extension after every rebuild.

## 3. Nothing to paste

The extension pairs with the MCP server on its first connection and keeps the token it receives, so
the pill goes from `MCP off` to `MCP live` on its own. There is no copy-paste step. The panel works
without the server, so `MCP off` is not an error, and the extension logs nothing while it waits.

One case still uses the field, in the panel and in the popup: the server runs with
`WASMCHEAT_PAIRING=off` (or with `WASMCHEAT_TOKEN` set). Then paste `cat ~/.wasmcheat/token`.

Why a token exists at all: the bridge listens on `ws://127.0.0.1:7331`, and without a secret any local
process could answer this server's tool calls with made-up data, or, while the server is down, pose as
it. Once paired, both ends prove they hold the token without sending it.

## 4. Start the demo

```bash
npm run demo
```

That serves the demo on <http://127.0.0.1:4173/>, opens it, and prints the extension path and the MCP
config block. (`node packages/demo-app/serve.mjs` does the same without opening anything.)

Foundry is a clicker: a score, ore, lives and a depth. Its state lives in linear memory, the single
block of bytes a WebAssembly module reads and writes, which is what the panel scans. Click **Mine** a
few times and leave the tab open.

## 5. Open the panel

Open DevTools on the Foundry tab (`⌥⌘I` / `Ctrl+Shift+I`) and choose the **WasmCheat** tab in the
DevTools toolbar. If the panel is not listed, reload the extension and reopen DevTools.

There is nothing to pick, attach or approve: the panel works on the tab you opened it on.

1. The header pill says `1 wasm module` and the Scan card's **Instance** field shows `w1`. If the
   page was open before you installed WasmCheat, the panel reloads it once and says so.
2. On a page with no WebAssembly the panel says **Nothing to analyze in this tab**. If the game only
   starts when you click something, start it: the panel notices on its own. **Why is it empty?**
   prints Diagnose (frames, `WebAssembly.instantiate` calls seen, whether the page blocks
   `new Function`).

## 6. Find the ore

The score climbs on its own, one point every 200 ms, so start with **Ore**: it changes only when you
press **Mine**.

1. Click **Mine** three times. The page shows `Ore 3`.
2. In **Scan** set Type `i32`, Value `3`, then **First Scan**. The Found list fills with candidates.
3. Click **Mine**. Ore is now `4`.
4. Type `4` into Value and press **Next Scan**. The list shrinks to the addresses that held `3` and
   now hold `4`. Press it again with a new value if more than one is left.
5. Click the address. An editor opens under the list with the current value in it.

## 7. Change it

- Type `123456` in **New value** and press **Write** (or Enter). The editor prints `4 -> 123456`.
  Switch to the game tab: Ore reads `123456`, with no reload.
- To hold a value, find **Lives** the same way, type `999` and press **Freeze**, then click
  **Hazard**. Lives stay at `999`: the page rewrites the value every 16 ms. The button now says
  **Unfreeze**.
- A value with no number on screen (a bar, a timer): leave Value empty and press **First Scan**,
  then press **Went up**, **Went down** or **Stayed the same** each time it moves or does not. On
  the demo the score only ever climbs, so press **Went up** a few times, a second apart, and the
  score's address is among the few left.
- Trust the `before -> after` line over the screen. A game redraws a number when it changes it, so
  the display can lag behind memory.

## 8. Let an agent do it

1. Register the MCP server with your agent: the one line for each client is in the README under
   [Connect your agent](../README.md#connect-your-agent).
2. Check that the panel's pill says `MCP live`.
3. Ask in plain words. First prompts that work:
   - "list my tabs"
   - "in the open tab, set my coins to 5000"
   - "add an aim line to this game and keep it"

The agent finds the value, changes it, reads it back, and with "keep it" saves the change as a mod
that runs again every time the game loads. [docs/AGENT_GUIDE.md](AGENT_GUIDE.md) is the method it
follows.

## Next

- [docs/PANEL.md](PANEL.md): every card, the shortcuts, and what each one maps to over MCP.
- [docs/AGENT_GUIDE.md](AGENT_GUIDE.md): the loop an agent runs, and its traps.
- [docs/TOOLS.md](TOOLS.md): every MCP tool with examples.
- [docs/DESIGN.md](DESIGN.md): why the panel looks and reads the way it does.

## When it does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| Popup says `MCP off` | No MCP server running, or a wrong port | Start the server; the popup retries with backoff |
| Popup says `MCP token refused` | Pairing is off and the saved token does not match `~/.wasmcheat/token` | Paste the current file contents and save |
| Panel says `MCP off` while the server runs | Its port differs from the extension's | Check `WASMCHEAT_PORT` |
| `NO_AGENT` | The page has no agent (it loaded before the extension, or the tab was replaced) | Press **Reload page** |
| `Nothing to analyze`, Diagnose says `calls.*` are all `0` | The app instantiated its module before the agent existed | Press **Reload page** |
| Instances empty, Diagnose lists a cross-origin frame | The game is in an iframe | Attach with the frame the panel reports, or let the extension pick it |
| Instances empty, Diagnose lists `.wasm` URLs, no frames | The wasm runs in a worker | Open **More tools** and check **Workers** |
| Scan finds 0 hits | Wrong width or wrong type | Try `i64` and `f64` before deciding the address is wrong |
| Hook calls fail with `HOOK_EVAL_BLOCKED` | The page's content security policy (CSP) forbids `new Function` | Use the declarative fallback (`passthrough`, `replace-return`, `offset-result`) |
