---
name: mod-any-webapp
description: Modify any web app or browser game open in the user's browser through the WasmCheat MCP tools, and keep the change as a mod that comes back on every load. Use when the user asks to mod, cheat, tweak, add a feature or a menu to, or change the behaviour of a page or game in their browser (YouTube Playables, Unity, PlayCanvas, Godot, Emscripten, three.js, Phaser, React or Vue apps, anything else), or to find where an app keeps a value. Covers checking the connection, recon, choosing a route (JavaScript objects, a save, wasm memory, Unity IL2CPP reflection), changing one thing live, writing a mod with an on-screen menu, keeping it, and the rules that keep it safe.
---

# Mod any web app

You change the app; the user plays and tells you what they see. Everything below is a WasmCheat MCP
tool call (`wasmcheat_*`). Every file this skill cites is also returned by `wasmcheat_guide`, so the
method works with nothing but the MCP server: `wasmcheat_guide {"topic":"probe"}` gives the probe's
code to pass to `wasmcheat_run_script`.

## 1. Check the connection

- `wasmcheat_list_tabs`. If it says no extension is connected, the user has to load the extension
  (see the project's QUICKSTART) and keep the browser open; it pairs with the server by itself.
- Pass `tabId` on every call: each browser window has a front tab, so "active" is ambiguous.
- `agentAttached: false` on the tab means the page loaded before the extension: ask the user to
  reload that tab. They also reload the tab after the extension itself was reloaded or updated.

## 2. Recon

1. `wasmcheat_diagnose {"tabId":T}`: frames, wasm instances, `.wasm` files, a physics-only engine.
2. `wasmcheat_run_script {"tabId":T,"code":<probe>}` with the code of `scripts/probe.js`: what the page
   added to `window`, which engine or framework it runs, its wasm, its storage, and whether it is a
   YouTube Playable. Scripts run in the frame that holds the game, even a cross-origin iframe.
3. Ask the user for one value they can see (coins, health, a level) and when it changes. Their number
   is the ground truth: a value that does not match it is the wrong one.

## 3. Pick a route

[references/routes.md](references/routes.md) has the recipe per background. In short:

| The app is | Its state lives in | Start with |
| --- | --- | --- |
| A YouTube Playable (any engine) | its save, then the engine | `await ytgame.game.loadData()` in `run_script` |
| PlayCanvas, three.js, Phaser, Pixi, Cocos, Babylon | JavaScript objects | walk the scene in `run_script` |
| Unity (IL2CPP) | wasm memory | the save's names, then `scripts/il2cpp.js` for classes and fields |
| Emscripten C/C++, Godot, Rust | wasm memory | `wasmcheat_scan` and narrow, then `wasmcheat_pointer_scan` |
| React, Vue, plain DOM | JavaScript state, network | framework internals, wrap `fetch` |

Look first for what the developers left in: debug switches, a god-mode flag, a feature the build turns
off. It is the cheapest change and the one least likely to break.

## 4. Change one thing live

- `wasmcheat_run_script` runs code in the game frame and returns its value. Every script gets two
  helpers: `until(check, timeoutMs, everyMs)` waits for something to exist (the check may be async),
  and `wasm(id = 'latest')` returns the game's wasm instance as `{id, memory, exports}`.
- Memory tools for values you cannot reach from JavaScript: `wasmcheat_scan` (first pass, then the
  same `scanId` with the new value), `wasmcheat_write`, `wasmcheat_freeze`, `wasmcheat_pointer_scan`,
  `wasmcheat_find_writes`, `wasmcheat_patch`, `wasmcheat_hook`, `wasmcheat_speed`. See their
  descriptions; `wasmcheat_attach` reloads the tab when the agent has to be in place before the game.
- After each change, read the value back and ask the user what the game shows. A value can be a copy
  the game overwrites later (a level's coin counter written back at the level's end): find the one
  that persists.
- Before a memory write, check the object is still what you think (its class word, plausible values):
  old copies linger in memory after a level ends.
- Never toggle a menu's switches yourself while the user is playing: you flip each other's clicks.
  Read the mod's state instead.

## 5. Make it a mod

1. Start from [references/mod-template.js](references/mod-template.js): a guard against a second run,
   `until` for what it waits on, a `state` and `actions` object, an on-screen menu that keeps its clicks
   off the game, and `window.__wasmcheatMod` so you can read its state later.
2. Find everything by name on every load (scene names, save keys, class and field names), never by an
   address seen once: addresses move on reload. A class that only exists in a level is looked for on
   each tick rather than awaited, so the menu works from the title screen.
3. Keep it: `wasmcheat_mod {"tabId":T,"action":"add","name":"…","code":<mod>}` runs it now and keeps it
   only if it works. Check the reply's origin is the game frame's, not the site around it.
4. Ask the user to reload the game, then read `window.__wasmcheatMod` back: it should be there on its own.
5. To change a mod: `action: "list"`, `action: "remove"` with its id, then `add` the new version.

Worked examples: [Bubble Tower 3D](references/examples/bubble-tower-3d.js) (PlayCanvas: aim line, swap,
colour, fireball, free misses) and [Stealth Master](references/examples/stealth-master.js) (Unity
IL2CPP: the game's own god mode, run speed, a coin multiplier, coins and tokens by save key).

## Rules

- Change what the client owns. Never change scores the app reports to a platform or a leaderboard,
  never touch multiplayer state, and leave anti-cheat flags in a save as they are.
- Ask before writing a save that syncs to the cloud, and keep a copy of it first.
- Every change is logged (`wasmcheat_audit`); say what you changed and how to undo it.
- Never solve a CAPTCHA, get past a bot check, or accept terms or a consent banner for the user.
