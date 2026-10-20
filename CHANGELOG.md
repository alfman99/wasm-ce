# Changelog

## Unreleased

- A script or a kept mod gets `wasm()`, the game's wasm instance with its memory and exports, so a mod
  works in games whose state is only in memory, such as Unity. `until` now also waits for an async
  check. The agent guide shows how a mod finds a Unity game's saved values by name on every load,
  where an address would move.
- A script can be kept for a game: **Run and keep** in the Script card, or `wasmcheat_mod` with
  `add` for an agent, runs it now and again on every load of the game's frame, until it is removed
  from the list under the card. Every script gets `until(check)`, which waits for the engine
  (`await until(() => window.pc?.app)`), so a kept script can start before the game does.
- A Script card in the panel and a `wasmcheat_run_script` tool run JavaScript in the game's frame
  and return its value, for what a game keeps in JavaScript rather than in memory, such as a
  PlayCanvas scene. It finds the frame by itself, even a cross-origin iframe, so code pasted from
  the DevTools console runs with no context to pick. Every run is logged with its code.
- A page with several WebAssembly modules (a Godot threaded build, for one) is ready to scan as soon
  as the panel opens: it picks the module with the most memory, so there is no instance to choose.
- A function patch survives the reload that installs it inside a sandboxed iframe, which is where
  every YouTube Playable runs and where the page has no `sessionStorage` to keep it in. Before, the
  patch vanished on that reload without a word.
- Right after a reload, before the game frame has created its wasm, calls go to the frame with the
  game's canvas rather than to the page around it.
- After a reload the panel no longer loses a game frame that announced itself before the page around
  it did, which left it on "Nothing to analyze" for good.
- The MCP server's start-up line names `packages/extension/dist`, the folder you actually load.
- When a page's only WebAssembly is a physics engine (Ammo.js, Box2D, Rapier, Havok, Jolt, PhysX),
  the panel, `diagnose` and `attach` say so: the game is JavaScript, so its score and coins are in
  no memory WasmCheat can scan.
- A page that enforces Trusted Types (YouTube itself) no longer leaves an error on the extension.
  The check for whether hook bodies can compile there now runs on the first hook that has one,
  instead of on every page load.
- Diagnosing a page, which the extension does for every frame when it picks one, takes milliseconds
  instead of seconds on pages with large minified inline scripts (YouTube, PlayCanvas games).

## 0.1.0

First public release.

- DevTools panel: scan for a value you can see, narrow it, change or freeze it. For a value you
  cannot read (a health bar), scan with no value and narrow with Went up, Went down, Changed or
  Stayed the same. Values in the panel update live, a page with no WebAssembly says so, and there
  is nothing to attach or approve.
- Finds games in cross-origin iframes (YouTube Playables, itch.io) and Web Workers, including a game
  frame that loads after the page.
- Watchpoints (which function wrote this address), function patches, export and import hooks,
  pointer chains, a speed hack, saved scans and bookmarks.
- A welcome tab on install says where the panel is and how to use it, once.
- An optional MCP server so an AI agent can do all of the above, over an authenticated local socket.
  Every change, from the panel or an agent, lands in one audit log, and an agent reading the log
  right after an action always sees that action.
