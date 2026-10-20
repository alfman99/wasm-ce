# Changelog

## 0.1.0

First public release.

- DevTools panel: scan for a value you can see, narrow it, change or freeze it. For a value you
  cannot read (a health bar), scan with no value and narrow with Went up, Went down, Changed or
  Stayed the same. Values in the panel
  update live, a page with no WebAssembly says so, and there is nothing to attach or approve.
- Finds games in cross-origin iframes (YouTube Playables, itch.io) and Web Workers, including a game
  frame that loads after the page.
- Watchpoints (which function wrote this address), function patches, export and import hooks,
  pointer chains, a speed hack, saved scans and bookmarks.
- An optional MCP server so an AI agent can do all of the above, over an authenticated local socket.
  Every change, from the panel or an agent, lands in one audit log.
