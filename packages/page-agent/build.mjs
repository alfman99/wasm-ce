import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/page-agent.js',
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: false,
  legalComments: 'none',
});
console.log('page-agent -> packages/page-agent/dist/page-agent.js');
