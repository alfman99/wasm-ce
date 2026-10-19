import { build } from 'esbuild';

// Two entries, two realms: the page agent patches `window.WebAssembly`, the worker agent patches
// `self.WebAssembly` and never touches a document (a worker global has none). Both are iife so
// they can be dropped into a MAIN-world content script and into `importScripts` respectively.
const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: false,
  legalComments: 'none',
};

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/page-agent.js' });
await build({ ...common, entryPoints: ['src/worker.ts'], outfile: 'dist/worker-agent.js' });

console.log('page-agent -> packages/page-agent/dist/page-agent.js');
console.log('page-agent -> packages/page-agent/dist/worker-agent.js');
