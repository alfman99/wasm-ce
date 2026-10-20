# Routes into an app, by what it is built with

Pick the route from what `scripts/probe.js` reports. Try them in this order: the cheapest route that
reaches the value wins, and JavaScript beats memory whenever the state is in JavaScript.

## Any app: what to look at first

- **A save or settings blob it keeps.** `localStorage`, IndexedDB, cookies, or a platform API. It usually
  names every value that matters, so it tells you what to look for before you look.
- **The app's own switches.** Developers leave debug flags, cheat utilities and god modes in builds
  (`_godModeActivated` and `CheatPlayerJumpsUtility` in Stealth Master). Search names for `debug`,
  `cheat`, `god`, `test`, `admin` before you build your own.
- **What the server owns stays on the server.** Prices checked at checkout, multiplayer state and
  reported scores are the server's. Change what the client owns and leave reported scores alone.

## YouTube Playables (any engine)

- The game runs in a sandboxed cross-origin iframe on `*.playables.usercontent.goog`. WasmCheat finds that
  frame by itself; `tabId` is the YouTube tab.
- `await ytgame.game.loadData()` returns the save as a string, usually JSON, that names the values the game
  keeps (`kCoins`, `kTokens`, `G_Current_Level`). Read it first; keep a local copy before any write.
- `ytgame.engagement.sendScore` and the game's own score reporting go to YouTube: never change scores.
- Some saves carry a cheat flag (`G_Cheated`): leave it at 0.
- A headless browser reaches the game frame directly at its `playables.usercontent.goog` URL;
  youtube.com itself stops at a consent page that must not be accepted for the owner.

## JavaScript engines (state lives in JS objects)

| Engine | Entry point | Walk it with |
| --- | --- | --- |
| PlayCanvas | `pc.app` | `pc.app.root.findByName('X')`, `entity.script.<name>`, `app.on/off(event)` |
| three.js | `THREE`, a scene held by the app | find the `Scene` from the renderer or app globals, `scene.traverse` |
| Babylon.js | `BABYLON.Engine.LastCreatedScene` | `scene.meshes`, `scene.getMeshByName` |
| Phaser | `Phaser.GAMES` or the app's `game` | `game.scene.scenes`, each scene's `children.list` and its own fields |
| PixiJS | `PIXI`, the app's `app.stage` | `stage.children`, recursive |
| Cocos Creator | `cc.director.getScene()` | `scene.children`, `node.getComponent('Name')` |
| Construct | `C3` / runtime globals | `runtime.objects`, instance variables |

- **Physics wasm only** (Ammo.js, Box2D, Rapier, Havok, Jolt, PhysX): `diagnose` says so. The game is
  JavaScript; memory holds bodies and forces, not the score.
- **Override, do not fork:** wrap a method (`const original = obj.update; obj.update = function (...a) {
  original.apply(this, a); … }`) and swap event listeners with `app.off/app.on`. A disabled feature the
  game ships (Bubble Tower's `aimController`) can just be switched on.

## Unity WebGL (IL2CPP, state in wasm memory)

- Signs: `createUnityInstance`, `unityFramework`, `Build/*.framework.js`, minified exports (`Qh`, `Rh`).
  Builds rarely export `il2cpp_*`, so reflection comes from memory: `scripts/il2cpp.js`.
- **Saved values by name.** PlayerPrefs-like stores are a `Dictionary<string, int>`: an entry is
  `{hash, next, key*, value}`, the key a string object `{klass, monitor, length, UTF-16}`. Find the
  string, then the words holding its address; the entry is the one whose `next` (the word before) is
  -1..1e5, and the value is the word after. Stealth Master had two such entries per key: write both.
- **Classes, fields and objects by name** with `scripts/il2cpp.js`: list assemblies, filter class names,
  then dump fields with offsets and sample values. The game code is in `Assembly-CSharp.dll` or a
  custom assembly (`AssetsAssembly.dll`).
- **Stale objects.** Old objects stay in memory until the GC reuses them. Validate an object before
  writing (class word still in place, monitor 0, values in a plausible range); write to every live one
  rather than guessing which is current.
- **Level copies.** A value shown during a level may be a copy written back at its end (Stealth Master's
  mission coins): write the persistent one.

## Emscripten C/C++, Godot, Rust (state in wasm memory)

- Scan: exact value, then narrow as the value changes in the game (`changed`, `increased`, a new exact
  value). An unknown value starts empty and narrows by movement. Try `f32`/`f64`/`i64` on a miss.
- Make it survive reloads: `pointer_scan` from the found address, prefer bases in the static data
  segment (low addresses, below the heap), then a mod resolves the path with `wasm()` on every load.
- Find the code: `find_writes` / `find_reads`, then `patch` (stub the function) or `hook` an export.
- Godot exposes `Engine` and keeps GDScript state in its own heap; scanning works as above.

## Plain web apps (DOM, frameworks)

- The page's own state: React `__reactFiber$…` / `__reactContainer$…` keys on DOM nodes lead to props
  and state; Vue 3 `el.__vueParentComponent`, `app.__vue_app__`; Redux stores often hang off `window`;
  Next.js data in `__NEXT_DATA__`.
- Network: wrap `fetch` and `XMLHttpRequest` in the page to read or reshape responses before the app
  sees them; this is the way to change what a server sent, for this client only.
- UI: add controls with plain DOM, styled inline so the app's CSS cannot reach them; stop pointer events
  from reaching the app below.
- A page that enforces Trusted Types or a strict CSP may refuse `run_script` (`HOOK_EVAL_BLOCKED`).
