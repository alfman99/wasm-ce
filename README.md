# WasmCheat

[![CI](https://github.com/alfman99/wasm-ce/actions/workflows/ci.yml/badge.svg)](https://github.com/alfman99/wasm-ce/actions/workflows/ci.yml)

**Ask your AI agent to change any web app or browser game, and keep the change as a mod that comes
back on every load.**

![A chat with an agent beside the demo game: the WasmCheat tools find the score in its WebAssembly
memory, set it to 1000000 and keep that as a mod, and the score is 1000000 again after a
reload](docs/img/agent-demo.gif)

WasmCheat is a browser extension and an MCP server. Your agent (Claude Code, Codex, Cursor or any MCP
client) looks at what the page is built with, changes it while it runs, and keeps the change. The
recording above runs the method on the bundled demo game: the chat lines are scripted, and every tool
call and result in it is what WasmCheat returned. A DevTools panel does the same by hand.

What an agent has done with it, each in one conversation:

- **Added a feature a game shipped turned off.** An aim line in a PlayCanvas bubble shooter, plus
  swap, recolour and a fireball on demand, from a menu drawn over the game.
- **Found a value in a compiled game and kept it changed.** Coins and tokens in a Unity game, by the
  names its save uses, and the game's own god mode and run speed, by reading Unity's class layout
  straight from memory.
- **Kept it.** Both menus come back on every reload, with nobody pasting anything.

It reaches what a page keeps in JavaScript (any engine or framework: PlayCanvas, three.js, Phaser,
React) and what a compiled game keeps in WebAssembly memory (Unity, Godot, Emscripten, Rust), including
games inside cross-origin iframes such as YouTube Playables and itch.io embeds. Every change is logged,
and WasmCheat sends nothing off your machine: see [PRIVACY.md](PRIVACY.md). Read the [Policy](#policy)
before you use it.

![Your AI agent talks MCP over stdio to the WasmCheat server on your machine, the server talks to the
browser extension over a WebSocket on 127.0.0.1, and the extension reaches the page's JavaScript and
WebAssembly memory in any frame](docs/img/how-it-works.svg)

## Install

You need Node 22 or newer and a Chromium browser, version 116 or newer (Chrome, Brave, Edge).

```bash
git clone https://github.com/alfman99/wasm-ce.git && cd wasm-ce
npm install
npm run build
```

Then load the extension:

1. Open `chrome://extensions` (`brave://extensions`, `edge://extensions`) and turn on **Developer mode**.
2. Press **Load unpacked** and pick the `packages/extension/dist` folder.
3. Pin WasmCheat to the toolbar. A welcome tab shows where the panel is.

Each [release](https://github.com/alfman99/wasm-ce/releases) also carries the extension as a zip, for the
panel alone: unzip it and load the `wasmcheat` folder inside the same way. The agent needs the MCP
server, which is built from source.

## Connect your agent

The MCP server is `packages/mcp-server/dist/bin.js`, started by your agent's client over stdio. Print its
full path from the repo folder with `echo "$PWD/packages/mcp-server/dist/bin.js"` and use it below.

**Claude Code**

```bash
claude mcp add wasmcheat --scope user -- node /full/path/to/wasm-ce/packages/mcp-server/dist/bin.js
```

**Claude Desktop**: in `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Cursor reads the same shape from
`~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "wasmcheat": {
      "command": "node",
      "args": ["/full/path/to/wasm-ce/packages/mcp-server/dist/bin.js"]
    }
  }
}
```

**Codex**: in `~/.codex/config.toml`.

```toml
[mcp_servers.wasmcheat]
command = "node"
args = ["/full/path/to/wasm-ce/packages/mcp-server/dist/bin.js"]
```

**Any other MCP client**: a stdio server with the command `node` and that path as its argument.

Restart the client, keep the browser open, and the extension pairs with the server by itself within a
few seconds: the panel's pill turns **MCP live**. Only one server can hold the connection at a time, so
do not also run `npm start` while your agent is connected.

## Ask for a change

Open the app or game, let it start, and talk to your agent:

> List my tabs and tell me what the game in front is built with.
>
> In this game, give me 5000 coins.
>
> Add an aim line to this game, with a small menu to turn it on and off, and keep it.

The server tells every agent the method when it connects, and serves the full guide and its scripts
through the `wasmcheat_guide` tool, so there is nothing else to set up. The agent works out where the
app keeps what you asked for, changes it, asks you what the game shows, and keeps the change as a mod.
Reload the page and the mod comes back on its own.

Two things help it: say the number you see on screen when it asks, since that is how it knows it found
the right value; and after you reload or update the extension, reload the game's tab too.

Agents that read [Agent Skills](https://agentskills.io) can also load the method as a skill: copy
[`.agents/skills/mod-any-webapp`](.agents/skills/mod-any-webapp/SKILL.md) into the agent's skills folder
(for Claude Code, `~/.claude/skills/`). The [agent guide](docs/AGENT_GUIDE.md) and the
[tool reference](docs/TOOLS.md) have the details.

## Or do it by hand

![The WasmCheat panel: the found list with live values beside the scan controls, and an editor open
on the address that holds the score](docs/img/panel.png)

1. Open the game and let it start.
2. Open DevTools (<kbd>F12</kbd>, or <kbd>⌥</kbd><kbd>⌘</kbd><kbd>I</kbd> on a Mac) and choose the
   **WasmCheat** tab. If you do not see it, look under <kbd>»</kbd>.
3. Type a number you can see in the game (your coins, say) and press **First Scan**.
4. Make the number change in the game, type the new value and press **Next Scan**. Repeat until one
   or two addresses are left. The list updates live, and a value that moved is highlighted.
5. Click an address, type a new value, and press **Write**, or **Freeze** to hold it there.

For a value you cannot read as a number, like a health bar, leave **Value** empty and narrow with
**Went up**, **Went down** and **Stayed the same**. The **Script** card under More tools runs JavaScript
in the game and keeps it as a mod with **Run and keep**. [docs/QUICKSTART.md](docs/QUICKSTART.md) walks
through it on the bundled demo game (`npm run demo`).

## Documentation

| If you want to | Read |
| --- | --- |
| change a value in five minutes, by hand or with an agent | [docs/QUICKSTART.md](docs/QUICKSTART.md) |
| know how an agent should work with it | [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) |
| look up a tool, its parameters and examples | [docs/TOOLS.md](docs/TOOLS.md) |
| learn the panel, card by card | [docs/PANEL.md](docs/PANEL.md) |
| see how it is built and why | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| know what is proven and what is not | [docs/STATUS.md](docs/STATUS.md) |
| know what it stores and sends | [PRIVACY.md](PRIVACY.md) |
| report a vulnerability | [SECURITY.md](SECURITY.md) |
| build, test and send a change | [CONTRIBUTING.md](CONTRIBUTING.md) |
| write about it or announce it | [docs/press](docs/press/README.md) |

## Policy

WasmCheat changes software running in your own browser. Use it on:

- your own apps and builds, and software you have permission to test;
- single-player games and web apps, for state that lives in your browser: a save, a menu, a feature the
  build ships switched off;
- CTFs, crackmes and teaching.

Do not use it to cheat other people: multiplayer games, leaderboards, scores a game reports to a platform,
or anything another player sees. Do not use it to get around payments, access controls or a CAPTCHA, or
to reach other people's accounts or data. You are responsible for following the terms of the software
you change. The server tells every agent the same rules, and the example mods follow them: they change
single-player state and leave reported scores alone.

## License

[MIT](LICENSE), by the WasmCheat contributors.
