import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Paths come from this file, not cwd: the root script builds every workspace at once.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(HERE, 'dist');
const SRC = join(HERE, 'src');

await mkdir(DIST, { recursive: true });

const bridgePort = Number(process.env.WASMCHEAT_PORT ?? 7331);

const common = {
  bundle: true,
  define: { __BRIDGE_PORT__: String(bridgePort) },
  target: ['chrome116'],
  sourcemap: false,
  legalComments: 'none',
};

// Service worker runs as a module worker (`type: module` in the manifest).
await build({ ...common, entryPoints: [join(SRC, 'sw.ts')], outfile: join(DIST, 'sw.js'), format: 'esm' });

// Content scripts are classic scripts, so they must not contain ESM syntax.
await build({ ...common, entryPoints: [join(SRC, 'relay.ts')], outfile: join(DIST, 'relay.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(SRC, 'popup.ts')], outfile: join(DIST, 'popup.js'), format: 'iife' });

// The DevTools bootstrap page and its panel are ordinary extension pages: IIFE, like the popup.
await build({ ...common, entryPoints: [join(SRC, 'devtools.ts')], outfile: join(DIST, 'devtools.js'), format: 'iife' });
await build({ ...common, entryPoints: [join(SRC, 'panel.ts')], outfile: join(DIST, 'panel.js'), format: 'iife' });

// The page agent and the worker agent are built by @wasmcheat/page-agent and shipped verbatim.
// worker-agent.js is a web_accessible_resource: blob workers can only importScripts it from there.
await copyFile(join(HERE, '../page-agent/dist/page-agent.js'), join(DIST, 'page-agent.js'));
await copyFile(join(HERE, '../page-agent/dist/worker-agent.js'), join(DIST, 'worker-agent.js'));

// dist/ is the loadable extension root, so the manifest's paths are relative to it.
await mkdir(join(DIST, 'icons'), { recursive: true });
for (const file of ['manifest.json', 'popup.html', 'popup.css', 'devtools.html', 'panel.html', 'panel.css', 'welcome.html', ...[16, 32, 48, 128].map((size) => `icons/${size}.png`)]) {
  await copyFile(join(file === 'manifest.json' ? SRC : HERE, file), join(DIST, file));
}

console.log(
  'extension -> packages/extension/dist/{manifest.json,sw,relay,popup,devtools,panel,page-agent,worker-agent}.js',
);
