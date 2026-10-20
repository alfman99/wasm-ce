# Agents in this repo

WasmCheat lets an agent change any web app or browser game through a browser extension and an MCP
server. The agent path comes first; the DevTools panel is the manual path.

- **Build and check:** see [CONTRIBUTING.md](CONTRIBUTING.md). `npm run build`, `npm run typecheck`,
  `npm run test:unit` and `npm run test:e2e` pass before a change is done.
- **How changes land:** a branch, a pull request with a test that fails without the change, CI green,
  squash merge. Docs and the CHANGELOG move in the same pull request. Publishing (a release, a store
  listing, a package) is a maintainer's decision.
- **Skills:**
  - [mod-any-webapp](.agents/skills/mod-any-webapp/SKILL.md): change an app open in the user's browser
    over MCP and keep the change as a mod. It ships to users too: the MCP server serves it through
    `wasmcheat_guide`, so edit it here and nowhere else.
  - [test-on-real-apps](.agents/skills/test-on-real-apps/SKILL.md): drive the tools from a shell in this
    repo against real tabs, and turn what a real app taught into a fix.
- **Product docs:** [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) for agents using WasmCheat,
  [docs/TOOLS.md](docs/TOOLS.md) for every tool, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it
  is built.
