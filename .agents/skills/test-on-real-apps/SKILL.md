---
name: test-on-real-apps
description: Drive the WasmCheat MCP tools from a shell in this repo against real tabs in the developer's browser, to test a change on real web apps and games or to build a mod while working on WasmCheat itself, then turn every workaround the agent needed into a fix with a test. Use when working in the wasm-ce repository and a change needs proof on a real app, when an MCP client is not registered in this session, or after a mod needed a workaround the product should not require.
---

# Test on real apps

The method for changing an app is the [mod-any-webapp](../mod-any-webapp/SKILL.md) skill. This skill is
how a contributor runs it from this repo, and how what it teaches lands in the product.

## Connect from a shell

```bash
npm run build                    # extension, page agent and MCP server
node scripts/hunt.mjs serve      # one MCP session, kept open (run it in the background)
node scripts/wc.mjs list_tabs    # the browser's tabs; the extension pairs by itself in seconds
```

- Any tool: `node scripts/wc.mjs <tool> '<json>'`, with the `wasmcheat_` prefix optional.
- Code from a file: `--code file.js` (several are joined in order); parameters: `--var NAME=JSON`, which
  puts `const NAME = JSON;` before the code. Example:
  `node scripts/wc.mjs run_script '{"tabId":T}' --code .agents/skills/mod-any-webapp/scripts/il2cpp.js --var CLASSES='["Character"]'`.
- Load `packages/extension/dist` unpacked. After a rebuild, reload the extension **and then the tab**:
  a tab keeps its old page agent until it reloads, and a mod kept from a tab the agent has not reached
  yet is refused.
- Stop the session before `npm run test:e2e`: the suite needs ports 7331, 7397 and 7399.

## Prove it without the developer's browser

A YouTube Playable's game frame loads straight from its `*.playables.usercontent.goog` URL in a headless
Chromium with `packages/extension/dist` loaded (`--load-extension`), so a mod can be kept, the page
reloaded and the mod read back with no human. Set `wasmcheatPort` in the extension's storage to a port
nothing listens on, so the headless copy does not pair with a running session. Some games need their
platform to get past loading (Stealth Master stays black headless): prove what you can there, and the
rest on the developer's real tab.

## Land what it taught

Every workaround is a missing feature: `wasmcheat_run_script`, kept mods, `until`, `wasm()` and the
probe all came from a mod that needed them.

1. A branch, and a test that fails without the change (`tests/unit` for logic, `tests/e2e` for anything
   crossing the extension).
2. The docs it changes in the same commit (README, docs/AGENT_GUIDE.md, docs/PANEL.md, the skill) and a
   line in CHANGELOG.md.
3. `npm run build && npm run typecheck && npm run test:unit && npm run test:e2e`, then a pull request,
   CI green, squash merge.
4. A new route or trick goes into the mod-any-webapp skill (`references/routes.md`), which the MCP server
   also serves through `wasmcheat_guide`; a new example mod goes into its `references/examples/`.
