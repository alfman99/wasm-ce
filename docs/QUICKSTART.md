# Quick start

From a clean clone to changing a value in a WebAssembly game, without an agent, in about five
minutes. Every command below runs from the repository root.

## 1. Build it

```bash
npm install
npm run build
```

`npm run build` compiles the protocol, the page agent, the extension, the MCP server and the demo.
It also compiles `packages/demo-app/src/game.c` to `packages/demo-app/prebuilt/game.wasm`, when it
can find a wasm-capable clang (see [README](../README.md#requirements)); otherwise the committed
`.wasm` is used unchanged.

## 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → choose `packages/extension/dist`.

That folder is the extension root: it holds `manifest.json`, the service worker, the page agent and
the DevTools panel. Reload the extension after every rebuild.

## 3. Nothing to paste

The extension pairs with the MCP server on its first connection and keeps the token it receives, so
the pill goes from `waiting for pairing` to `bridge live` on its own. There is no copy-paste step.

One case still uses the field, in the panel and in the popup: the server runs with
`WASMCHEAT_PAIRING=off` (or with `WASMCHEAT_TOKEN` set). Then paste `cat ~/.wasmcheat/token`.

Why a token exists at all: the bridge listens on `ws://127.0.0.1:7331`, and without a secret any local
process could answer this server's tool calls with made-up data.

## 4. Start the target

```bash
npm run demo
```

That serves the demo on <http://127.0.0.1:4173/>, opens it, and prints the extension path and the MCP
config block. (`node packages/demo-app/serve.mjs` does the same without opening anything.)

Foundry is a clicker: a score, ore, lives and a depth. Its state lives in linear memory, which is
what makes it a target rather than a toy. Click **Mine** a few times and leave the tab open.

## 5. Open the panel

Open DevTools on the Foundry tab (`⌥⌘I` / `Ctrl+Shift+I`) and choose the **WasmCheat** tab in the
DevTools toolbar. If the panel is not listed, reload the extension and reopen DevTools.

1. The panel already targets this tab, so there is nothing to pick. If the page agent is there (it
   is, whenever the extension was loaded before the page), the panel finds the wasm by itself: the
   **Instance** field in Scan shows `w1` and the steps strip is on **2 Scan for a value**.
2. If **Attach** is highlighted instead, press it. It starts the agent, reloading the tab once when
   the page loaded before the extension, and when it still finds no wasm it prints **Diagnose**
   (frames, `WebAssembly.instantiate` calls seen, whether the page blocks `new Function`).
3. If the game only starts when you click something, start it and press **Reload & attach**: the page
   agent has to exist before the game instantiates its module.

## 6. Find the score

1. Click **Mine** three times. The page shows `Score 75`.
2. In **Scan** set Type `i32`, Value `75`, then **First Scan**. The Found list fills with
   candidates: a fresh module is mostly zeros, so there are more than you expect.
3. Click **Mine**. Score is now `100`.
4. Type `100` into Value and press **Next Scan**. The list shrinks to the addresses that held `75`
   and now hold `100`. Press it again with a new value if you want a single hit.
5. Click the address. An editor opens under the list with the current value in it.

## 7. Change it

- Type `123456` in **New value** and press **Write** (or Enter). The editor prints `100 -> 123456`.
  Switch to the game tab: the score reads `123456`, with no reload.
- To hold a value, find **Lives** the same way, type `999` and press **Freeze**, then click
  **Hazard**. Lives stay at `999`: the page rewrites the value every 16 ms. The button now says
  **Unfreeze**.
- Trust the `before -> after` line over the screen. A game redraws a number when it changes it, so
  the display can lag behind memory.

## 8. Next

- [docs/PANEL.md](PANEL.md): every card, the shortcuts, and what each one maps to over MCP.
- [docs/AGENT_GUIDE.md](AGENT_GUIDE.md): the same loop, driven by an MCP client.
- [docs/DESIGN.md](DESIGN.md): why the panel looks and reads the way it does.

## When it does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| Popup says `bridge offline` | No MCP server running, or a wrong port | Start the server; the popup retries with backoff |
| Popup says `token refused` | Pairing is off and the saved token does not match `~/.wasmcheat/token` | Paste the current file contents and save |
| Panel says `waiting for pairing` | The server is not up yet, or its port differs from the extension's | Start it, and check `WASMCHEAT_PORT` |
| `NO_AGENT` | The page has no agent (it loaded before the extension, or it navigated) | Press **Attach**, or **Reload & attach** if the game starts on a click |
| `NO_AGENT` | The page agent is not in the page (loaded after it, or the tab was replaced) | **Detach**, then **Attach**; use **Reload & attach** if it still fails |
| Instances empty, Diagnose says `calls.*` are all `0` | The app instantiated its module before the agent existed | **Reload & attach** |
| Instances empty, Diagnose lists a cross-origin frame | The game is in an iframe | Attach with the frame the panel reports, or let the extension pick it |
| Instances empty, Diagnose lists `.wasm` URLs, no frames | The wasm runs in a worker | Open **More tools** and check **Workers** |
| Scan finds 0 hits | Wrong width or wrong type | Try `i64` and `f64` before deciding the address is wrong |
| Hook calls fail with `HOOK_EVAL_BLOCKED` | The page's CSP forbids `new Function` | Use the declarative fallback (`passthrough`, `replace-return`, `offset-result`) |
