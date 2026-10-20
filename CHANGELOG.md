# Changelog

## Unreleased

- A page with several WebAssembly modules (a Godot threaded build, for one) is ready to scan as soon
  as the panel opens: it picks the module with the most memory, so there is no instance to choose.
- A function patch survives the reload that installs it inside a sandboxed iframe, which is where
  every YouTube Playable runs and where the page has no `sessionStorage` to keep it in. Before, the
  patch vanished on that reload without a word.
- Right after a reload, before the game frame has created its wasm, calls go to the frame with the
  game's canvas rather than to the page around it.
- The MCP server's start-up line names `packages/extension/dist`, the folder you actually load.

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
