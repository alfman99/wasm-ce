# Privacy

WasmCheat collects nothing and sends nothing anywhere.

## What leaves your computer

Nothing. The extension makes one kind of network connection: to `127.0.0.1` (your own machine), on
port 7331, to reach the optional MCP server if you run it. Before dialing it checks with a request to
the same local address whether anything is listening. There is no analytics, no telemetry, no update
check and no server run by the project.

## What the extension can see

To scan a game's memory, WasmCheat runs a small script in every http and https page you open, and
in their frames and workers. That script only records which WebAssembly modules the page creates.
It reads or changes memory only when you (or an MCP agent you started) ask it to, and the results
go to the DevTools panel or that agent, nowhere else.

## What is stored, and where

All of it stays in your browser or on your disk:

| What | Where |
| --- | --- |
| The MCP pairing token, the bridge port, the panel's light or dark theme, scripts you keep for a game (their code and the game's origin) | the extension's own storage (`chrome.storage.local`) |
| Which tabs and frames have the agent, for the current browser session | `chrome.storage.session`, cleared when the browser closes |
| Bookmarks you add | that site's `localStorage` |
| Saved scans, armed watchpoints, function patches | that site's `sessionStorage`, gone when the tab closes |
| The audit log of every change (only if you run the MCP server) | `~/.wasmcheat/audit.jsonl`, readable by your user only |

Removing the extension deletes its own storage. Bookmarks and saved scans live with each site's data
and go away when you clear that site's data.

## Questions

Open an issue at <https://github.com/alfman99/wasm-ce/issues>.
