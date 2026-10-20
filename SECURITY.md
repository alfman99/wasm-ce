# Security

## Reporting a vulnerability

Please report security problems privately through
[GitHub security advisories](https://github.com/alfman99/wasm-ce/security/advisories/new), not in a
public issue. Include the browser and version, what you did, and what an attacker gains. You should
get an answer within a week.

## What is in scope

WasmCheat holds two kinds of power, and both are in scope:

- **The extension** can read and write the memory of any http or https page it runs in. A bug that
  lets a web page reach the extension's own messaging (`wasmcheat.panel.call`, the tab list, another
  tab's memory) is a vulnerability.
- **The bridge** between the extension and the optional MCP server is a WebSocket on
  `127.0.0.1:7331`, authenticated with a token both ends prove they hold (see "The bridge" in the
  README). A way for another local program or a web page to issue commands over it, read the token,
  or impersonate the server to the extension is a vulnerability.

Out of scope: what a person does with the tool on a page they opened themselves. The page agent
runs in the page's own JavaScript world by design, so the page can see that it is there.
