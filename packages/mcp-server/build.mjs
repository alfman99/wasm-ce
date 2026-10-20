import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// The mod-any-webapp skill, inlined so the server can serve it (src/guide.ts) with no repo around it.
const skill = new URL('../../.agents/skills/mod-any-webapp/', import.meta.url);
const read = (path) => readFileSync(new URL(path, skill), 'utf8');
const guide = {
  workflow: read('SKILL.md').replace(/^---\n[\s\S]*?\n---\n+/, ''),
  routes: read('references/routes.md'),
  probe: read('scripts/probe.js'),
  il2cpp: read('scripts/il2cpp.js'),
  'mod-template': read('references/mod-template.js'),
  'example-playcanvas': read('references/examples/bubble-tower-3d.js'),
  'example-unity': read('references/examples/stealth-master.js'),
};

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  sourcemap: false,
  legalComments: 'none',
  // The MCP SDK pulls optional provider packages that must stay external.
  external: ['zod', '@modelcontextprotocol/sdk', 'ws'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __WASMCHEAT_GUIDE__: JSON.stringify(guide) },
});

console.log('mcp-server -> packages/mcp-server/dist/bin.js');
