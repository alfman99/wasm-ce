---
name: mod-any-webapp
description: Modify any running web app or browser game through the WasmCheat extension, as an agent over MCP, and keep the change as a mod that survives reloads. Use when the owner asks to mod, cheat, hack, tweak, add a feature or a menu to, or change the behaviour of a page or game open in their browser (YouTube Playables, Unity, PlayCanvas, Godot, Emscripten, three.js, Phaser, React or Vue apps, anything else), or to find where an app keeps a value. Covers recon, choosing a route (JavaScript objects, a save, wasm memory, IL2CPP reflection), prototyping live, writing a mod with a HUD, keeping it per game origin, and turning each workaround into a product fix.
---

# Mod any web app

WasmCheat's point: change any app at will, mainly through an agent connected to the extension. The
agent does the work over MCP; the owner only plays and says what they see. Never leave the owner a
manual step (a console, a frame picker) that the extension could do: make it a tool instead.

## 0. Connect

```bash
npm run build                        # extension, page agent and MCP server
node scripts/hunt.mjs serve          # keeps one MCP session open (run in the background)
node scripts/wc.mjs list_tabs        # the owner's tabs; the extension pairs by itself in seconds
```

- The owner loads `packages/extension/dist` unpacked. After a rebuild they reload the extension
  **and then the tab**: a tab keeps its old page agent until it reloads.
- Call any tool as `node scripts/wc.mjs <tool> '<json>'`; pass code from a file with `--code file.js`
  and parameters with `--var NAME=JSON`. Always pass `tabId`: `list_tabs` marks each window's front tab
  active.
- Stop the session before `npx playwright test` (it uses ports 7397, 7399 and 7331).

## 1. Recon

1. `node scripts/wc.mjs diagnose '{"tabId":T}'`: frames, instances, wasm, a physics-only engine.
2. `node scripts/wc.mjs run_script '{"tabId":T}' --code .agents/skills/mod-any-webapp/scripts/probe.js`:
   page globals, engine, framework, wasm size, storage, and whether it is a YouTube Playable.
3. Ask the owner for one value they can see (coins, health) and when it changes. Their numbers are the
   ground truth; a value that does not match what they see is the wrong one.

## 2. Pick a route

Read [references/routes.md](references/routes.md) for the recipe per background. In short:

| The app is | Its state lives in | Start with |
| --- | --- | --- |
| A YouTube Playable (any engine) | its save, then the engine | `await ytgame.game.loadData()` |
| PlayCanvas, three.js, Phaser, Pixi, Cocos, Babylon | JavaScript objects | walk the scene in `run_script` |
| Unity IL2CPP | wasm memory | save names, then `scripts/il2cpp.js` |
| Emscripten C/C++, Godot, Rust | wasm memory | `scan` and narrow, then `pointer_scan` |
| React, Vue, plain DOM | JS state, network | framework internals, wrap `fetch` |

Look for what the developers left in first (debug switches, a god-mode flag, a disabled feature): it is
the cheapest and the most stable thing to flip.

## 3. Prototype live

- `run_script` runs in the game frame, even a cross-origin iframe. Every script gets
  `until(check, timeoutMs, everyMs)` and `wasm(id = 'latest')` (`{id, memory, exports}`).
- Change one thing, then read it back and ask the owner what the game shows. A HUD can lag a value, and
  a value can be a copy that the game overwrites (the mission coins in Stealth Master).
- Memory writes: validate the object first (class word, plausible ranges) because stale copies linger.
- Do not toggle the mod's switches while the owner is playing: you flip each other's clicks. Ask, or
  read the state instead.

## 4. Make it a mod

1. Start from [references/mod-template.js](references/mod-template.js): a once-guard, `until`, a
   state + actions object, a HUD that keeps clicks off the game, `window.__wasmcheatMod` for an agent.
2. Find everything by name on every load (scene names, save keys, IL2CPP classes and fields), never by
   an address from this session. Examples: [Bubble Tower 3D](references/examples/bubble-tower-3d.js)
   (PlayCanvas: aim line, swap, colour, fireball, free misses), [Stealth Master](references/examples/stealth-master.js)
   (Unity IL2CPP: god mode, speed, coin multiplier, coins and tokens).
3. Keep it: `node scripts/wc.mjs mod '{"tabId":T,"action":"add","name":"…"}' --code mod.js`. Check the
   reply's origin is the **game frame's** (`*.playables.usercontent.goog`), never the site around it.
   A mod that throws is not kept.
4. Ask the owner to reload the game; read `window.__wasmcheatMod` back to confirm it came back alone.
5. Replace a kept mod by removing the old id (`action: list`, then `remove`) before adding the new one.

## 5. Leave the product better

Each workaround is a missing feature: the `run_script` tool, kept mods, `until` and `wasm()` all came
from a mod that needed them. Turn it into a fix on a branch with a test that fails first, the docs it
changes and a CHANGELOG line, then a PR (CI green, squash merge). Save what the game taught to memory.

## Rules

- Change only what the client owns. Never change scores the game reports to a platform, leave cheat
  flags in saves at 0, and keep a local backup before writing a save that syncs to the cloud.
- Ask before writing the owner's save or anything that leaves their machine.
- Never solve a CAPTCHA, get past a bot check or accept a consent banner for the owner.
- The product guide for agents using WasmCheat is [docs/AGENT_GUIDE.md](../../../docs/AGENT_GUIDE.md);
  this skill is how we work, that guide is what we ship.
