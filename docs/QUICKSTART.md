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

## 3. Copy the bridge token

```bash
cat ~/.wasmcheat/token
```

The MCP server mints this file on first start and prints its path, never the token itself. Open the
WasmCheat popup (or the panel) and paste it into **Bridge token**. The pill in the popup turns to
`bridge connected` once it is accepted.

Why a token exists: the bridge listens on `ws://127.0.0.1:7331`, and without a secret any local
process could claim to be the extension and answer the server's calls with invented data.

## 4. Start the target

```bash
node packages/demo-app/serve.mjs
# then open http://127.0.0.1:4173/
```

Foundry is a clicker: a score, ore, lives and a depth. Its state lives in linear memory, which is
what makes it a target rather than a toy. Click **Mine** a few times and leave the tab open.

## 5. Open the panel

Open DevTools on the Foundry tab (`⌥⌘I` / `Ctrl+Shift+I`) and choose the **WasmCheat** tab in the
DevTools toolbar. If the panel is not listed, reload the extension and reopen DevTools.

1. In **Tabs**, click the Foundry row. It becomes the target.
2. Click **Attach**. The first attach for a site asks for approval: press **Approve**. Nothing runs
   in the tab until you do.
3. In **Instances**, press **Refresh** and look for an entry with a memory size and an export list.
   Empty? Press **Diagnose** — it reports the frames the page has, whether the agent saw any
   `WebAssembly.instantiate` call, and whether the page blocks `new Function`.

## 6. Find the score

1. Click **Mine** three times. The page shows `Score 75`.
2. In **Scan** set Type `i32`, Value `75`, then **First Scan**. The Found list fills with
   candidates: a fresh module is mostly zeros, so there are more than you expect.
3. Click **Mine**. Score is now `100`.
4. Type `100` into Value and press **Next Scan**. The list shrinks to the addresses that held `75`
   and now hold `100`. Press it again with a new value if you want a single hit.
5. Click the address. Every form now holds `w1:0x408` and the memory viewer is looking at it.

## 7. Change it

- **Write 123456** in **Reads / writes**. Switch to the game tab: the score reads `123456`, with no
  reload.
- **Freeze** the same address at `999`, then click **Hazard**. Lives stay at `999`: a page-side
  timer rewrites the value every 16 ms.
- Read the address back (**Read one**) before believing anything. The page may round, reformat or
  cache what it prints.

## 8. Next

- [docs/PANEL.md](PANEL.md) — every card, the shortcuts, and what each one maps to over MCP.
- [docs/AGENT_GUIDE.md](AGENT_GUIDE.md) — the same loop, driven by an MCP client.
- [docs/DESIGN.md](DESIGN.md) — why the panel looks and reads the way it does.

## When it does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| Popup says `bridge offline` | No MCP server running, or a wrong port | Start the server, or save the right token; the popup retries with backoff |
| Popup says `token refused` | The saved token does not match `~/.wasmcheat/token` | Paste the current file contents and save |
| `NEED_APPROVAL` | The human has not approved this tab and site | Press **Approve** in the popup or the panel |
| `NO_AGENT` | The page agent is not in the page (loaded after it, or the tab was replaced) | **Detach**, then **Attach**; use **Reload & attach** if it still fails |
| Instances empty, Diagnose says `calls.*` are all `0` | The app instantiated its module before the agent existed | **Reload & attach** |
| Instances empty, Diagnose lists a cross-origin frame | The game is in an iframe | Attach with the frame the panel reports, or let the extension pick it |
| Instances empty, Diagnose lists `.wasm` URLs, no frames | The wasm runs in a worker | Check the **Workers** card |
| Scan finds 0 hits | Wrong width or wrong type | Try `i64` and `f64` before deciding the address is wrong |
| Hook calls fail with `HOOK_EVAL_BLOCKED` | The page's CSP forbids `new Function` | Use the declarative fallback (`passthrough`, `replace-return`, `offset-result`) |
