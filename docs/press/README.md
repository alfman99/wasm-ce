# Press kit

Text and images for writing about WasmCheat or announcing a release. Everything here is free to use.
Every fact below can be checked in this repository; if you need one that is not here, open an issue
rather than guessing.

## In one line

WasmCheat lets your AI agent change any web app or browser game, and keep the change as a mod that comes
back on every load.

## In one paragraph

WasmCheat is a browser extension and an MCP server. Connect it to Claude Code, Codex, Cursor or any
other MCP client, open a game in your browser and ask for what you want: 5000 coins, an aim line, a menu
of switches. The agent works out what the page is built with, finds where it keeps that value (in
JavaScript, in a save, or in WebAssembly memory), changes it while the game runs and keeps the change as
a mod that runs again on every load. A DevTools panel does the same by hand. It is MIT licensed, and
WasmCheat sends nothing off your machine.

## Facts

- An MV3 extension for Chromium browsers (Chrome, Brave, Edge, version 116 or newer) and an MCP server
  that runs on your machine over stdio. They talk over a WebSocket on 127.0.0.1 with a pairing token.
- 28 MCP tools: scan and narrow, write and freeze, pointer scans, watchpoints (which function wrote this
  address), function patches, export and import hooks, a speed hack, running JavaScript in the game's
  frame, kept mods, an audit log of every change, and `wasmcheat_guide`, which teaches an agent the method.
- It reaches games inside cross-origin iframes, such as YouTube Playables and itch.io embeds.
- Two worked examples ship with the skill, each built by an agent in one conversation:
  - Bubble Tower 3D (PlayCanvas): an aim line, swap, recolour and a fireball, from a menu over the game.
  - Stealth Master (Unity IL2CPP): the game's own god mode and run speed, a coin multiplier, and coins
    and tokens found by the names in its save, read from Unity's class layout in memory.
- Install is from source today (`npm install && npm run build`, then load the unpacked extension). It is
  not in the Chrome Web Store.
- Made for single-player state in your own browser. The [Policy](../../README.md#policy) rules out
  multiplayer games, leaderboards, reported scores, payments and other people's data.

## Images

| File | What it shows | Size |
| --- | --- | --- |
| [`docs/img/agent-demo.gif`](../img/agent-demo.gif) | A real agent session: find the score, set it, keep it, reload | 1000 px wide |
| [`docs/img/social-card.png`](../img/social-card.png) | The social preview card | 1280 × 640 |
| [`docs/img/how-it-works.svg`](../img/how-it-works.svg) | Agent, server, extension and page, and what talks to what | vector |
| [`docs/img/panel.png`](../img/panel.png), [`panel-dark.png`](../img/panel-dark.png) | The DevTools panel, light and dark | |
| [`packages/extension/icons`](../../packages/extension/icons) | The icon | |

The GIF, the social card and the screenshots are made by the test suite from the real product
(`WASMCHEAT_SHOTS=1 npx playwright test tests/e2e/promo.spec.ts tests/e2e/screenshots.spec.ts`), so they
stay true as it changes.

## Launch posts

Drafts for the owner to post. Replace the link if the repository moves.

### Show HN

**Title:** Show HN: WasmCheat, let your AI agent mod any browser game and keep the mod

I wanted to ask an agent "give me 5000 coins in this game" and have it just happen, including in Unity
games where the coins only exist in WebAssembly memory. WasmCheat is a Chromium extension plus an MCP
server. The agent probes the page (engine, frameworks, wasm, save), picks where the value lives, changes
it live, asks you what the game shows, and keeps the change as a mod that runs again on every load of
the game's frame.

Things that surprised me while building it:

- Many web games keep their state in JavaScript, so running code in the right frame (often a sandboxed
  cross-origin iframe) gets you further than a memory scanner.
- For Unity IL2CPP builds you can read class and field names straight out of memory, so a mod can find
  "coins" by name on every load instead of by an address that moves.
- The server teaches the method to any agent through its MCP instructions and a `wasmcheat_guide` tool,
  so there is nothing to install on the agent side.

It is for single-player state in your own browser; the README has the policy. MIT. Install is from
source for now: https://github.com/alfman99/wasm-ce

### Reddit

**Title:** I made an MCP server that lets Claude Code / Codex / Cursor mod browser games, and the mod
survives reloads

You connect the agent, open a game and ask in plain words. It found the score in the demo's wasm memory,
set it to a million and kept it; on a reload it was a million again (the GIF in the README is that exact
session). It has also added an aim line and a fireball menu to a PlayCanvas bubble shooter, and switched
on a Unity game's own god mode by reading its class layout from memory. There is a DevTools panel for
doing it by hand, like a small Cheat Engine for wasm. Single-player only, MIT, install from source:
https://github.com/alfman99/wasm-ce

### X / Bluesky

Ask your AI agent to change any web game. The change comes back on every load.

WasmCheat: a browser extension and an MCP server for Claude Code, Codex, Cursor and other agents. MIT.
https://github.com/alfman99/wasm-ce

(Attach `docs/img/agent-demo.gif`.)
