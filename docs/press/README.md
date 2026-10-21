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
| [`video/wasmcheat-launch.mp4`](video/wasmcheat-launch.mp4) | A 21 second launch video with sound, for X, Bluesky, LinkedIn and YouTube; poster [`.jpg`](video/wasmcheat-launch.jpg) | 1920 × 1080 |
| [`video/wasmcheat-launch-vertical.mp4`](video/wasmcheat-launch-vertical.mp4) | The same video for Shorts, Reels and TikTok; poster [`.jpg`](video/wasmcheat-launch-vertical.jpg) | 1080 × 1920 |
| [`docs/img/agent-demo.gif`](../img/agent-demo.gif) | The method on the demo game, from a scripted chat with real tool calls and results: find the score, set it, keep it, reload | 1000 px wide |
| [`docs/img/social-card.png`](../img/social-card.png) | The social preview card | 1280 × 640 |
| [`docs/img/how-it-works.svg`](../img/how-it-works.svg) | Agent, server, extension and page, and what talks to what | vector |
| [`docs/img/panel.png`](../img/panel.png), [`panel-dark.png`](../img/panel-dark.png) | The DevTools panel, light and dark | |
| [`packages/extension/icons`](../../packages/extension/icons) | The icon | |

The GIF, the social card and the screenshots are made by the test suite from the real product
(`WASMCHEAT_SHOTS=1 npx playwright test tests/e2e/promo.spec.ts tests/e2e/screenshots.spec.ts`), so they
stay true as it changes. The videos are drawn from the session that the promo test records: every tool call,
result and game shot in them is what WasmCheat returned, and the chat lines around them are scripted. Rebuild them after that test with
`node docs/press/video/source/render.mjs` (needs ffmpeg, ImageMagick, and python3 with numpy for the
soundtrack, which [`sound.py`](video/source/sound.py) synthesizes, so there is no music licence to clear).

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
  so the agent needs nothing but the MCP server.

It is for single-player state in your own browser; the README has the policy. MIT. Install is from
source for now: https://github.com/alfman99/wasm-ce

### Reddit

**Title:** I made an MCP server that lets Claude Code / Codex / Cursor mod browser games, and the mod
survives reloads

You connect the agent, open a game and ask in plain words. It finds the score in a game's wasm memory,
sets it to a million and keeps that as a mod, so it is a million again after a reload (the GIF in the
README shows it on the bundled demo, with real tool calls and results). In real sessions it has also added an aim line and a fireball menu to a PlayCanvas bubble shooter, and switched
on a Unity game's own god mode by reading its class layout from memory. There is a DevTools panel for
doing it by hand, like a small Cheat Engine for wasm. Single-player only, MIT, install from source:
https://github.com/alfman99/wasm-ce

### X / Bluesky

Ask your AI agent for a million points in a browser game, and to keep them after a reload. WasmCheat
finds the score in the game's WebAssembly memory, changes it and keeps it as a mod, so it is back on
every load. A browser extension and an MCP server for Claude Code, Codex and Cursor, MIT:
https://github.com/alfman99/wasm-ce

(Attach `video/wasmcheat-launch.mp4`; on a vertical feed, `video/wasmcheat-launch-vertical.mp4`.)
