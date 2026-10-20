# Contributing to WasmCheat

Thanks for helping. Bug reports with a reproducible page are the most useful thing you can send;
code is welcome too.

## Set up

You need Node 22 or newer and Chrome, Chromium, Brave or Edge 116 or newer.

```bash
git clone https://github.com/alfman99/wasm-ce.git && cd wasm-ce
npm install
npx playwright install chromium   # once, for the end-to-end tests
npm run build
```

Load `packages/extension/dist` with **Load unpacked** on `chrome://extensions` (developer mode on),
then `npm run demo` serves a small game to try it on. Reload the extension after every build.

## Before you open a pull request

```bash
npm run build
npm run typecheck
npm run test:unit
npm run test:e2e
```

CI runs the same four steps on every pull request. The end-to-end suite drives a real Chromium with
the real extension, so a change to the panel, the service worker or the page agent needs it green.

- **One change per pull request**, with a test that fails without it. Bug fixes fix the shared
  function every caller goes through, not just the path in the report.
- **Docs move with the code.** If a label, a pill or a flow changes, update `docs/PANEL.md`,
  `docs/QUICKSTART.md` and the README in the same pull request, and regenerate the screenshots:
  `WASMCHEAT_SHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts`.
- **UI and copy follow `docs/DESIGN.md`**: one accent, sentence case, buttons that say what they do,
  error messages that name the fix, and no em dashes.
- **No new runtime dependencies** without a reason in the pull request. The extension ships none.

## Where things live

| Path | What it is |
| --- | --- |
| `packages/page-agent` | Runs inside the page and its workers: captures wasm instances, scans, writes, hooks. |
| `packages/extension` | The MV3 extension: service worker, relay, DevTools panel, popup. |
| `packages/mcp-server` | The optional MCP server that lets an AI agent drive the extension. |
| `packages/protocol` | Types and error codes shared by all of the above. |
| `packages/wasm-instrument` | The wasm rewriter behind watchpoints and patches. |
| `packages/demo-app` | The demo game and its test pages. |
| `tests/unit`, `tests/e2e` | Vitest unit tests and Playwright end-to-end tests. |

`docs/STATUS.md` lists what is proven and what is a known limit; it is the best place to find
something worth working on.

## Releasing (maintainers)

Bump `version` in `package.json` and `packages/extension/src/manifest.json`, add a section to
`CHANGELOG.md`, then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow builds, runs the tests, and attaches `wasmcheat-extension-v0.2.0.zip` to a
GitHub release. `npm run package` builds the same zip locally.

## Ground rules

Be kind and assume good faith. WasmCheat is for software you own or may test (see the Policy section
of the README); pull requests that target a specific third-party service or add evasion of
anti-cheat or DRM will be closed.
