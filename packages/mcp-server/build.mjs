import { build } from 'esbuild';

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
});

console.log('mcp-server -> packages/mcp-server/dist/bin.js');
