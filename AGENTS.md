# Agents in this repo

WasmCheat lets an agent change any web app or browser game through a browser extension and an MCP
server. The agent path comes first; the panel is the manual path.

- **Build and check:** see [CONTRIBUTING.md](CONTRIBUTING.md). `npm run build`, `npm run typecheck`,
  `npm run test:unit`, `npm run test:e2e` must pass before a change is done.
- **How changes land:** a branch, a pull request with a test that fails without the change, CI green,
  squash merge. Docs and the CHANGELOG move in the same pull request. The repo is private but is run as
  if it were public; making it public or publishing to a store or registry is the owner's call alone.
- **Skills:**
  - [mod-any-webapp](.agents/skills/mod-any-webapp/SKILL.md): modify a running app or game over MCP and
    keep the change as a mod. Use it whenever the owner asks to change an app open in their browser.
- **Product docs for agents that use WasmCheat:** [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md).
