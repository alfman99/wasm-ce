import { build } from 'esbuild';
import { copyFile, mkdir, access, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const run = promisify(execFile);

// Resolved from this file, not cwd: the root script runs `node packages/demo-app/build.mjs`.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, 'out');
const PREBUILT = join(HERE, 'prebuilt');
const SRC = join(HERE, 'src');

const EXPORTS = [
  'tick',
  'mine',
  'take_damage',
  'reset_game',
  'get_score',
  'get_coins',
  'get_lives',
  'get_level',
];

// A standalone module: no Emscripten glue, no libc, no 16MB heap. `src/demo.js` drives it
// through `instance.exports`, which is what makes a live export patch observable.
const WASM_ARGS = [
  '--target=wasm32',
  '-O2',
  '-nostdlib',
  '-Wl,--no-entry',
  ...EXPORTS.map((name) => `-Wl,--export=${name}`),
  '-Wl,--export-memory',
  '-Wl,--initial-memory=131072',
  '-Wl,-z,stack-size=16384',
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Apple's clang has no wasm32 target, so look for the LLVM that ships with Emscripten. */
async function candidates() {
  const found = [];
  if (process.env.WASMCHEAT_CLANG) found.push(process.env.WASMCHEAT_CLANG);
  if (process.env.EMSDK) found.push(join(process.env.EMSDK, 'upstream', 'bin', 'clang'));
  for (const root of ['/opt/homebrew/Cellar/emscripten', '/usr/local/Cellar/emscripten']) {
    let versions = [];
    try {
      versions = (await readdir(root)).sort().reverse();
    } catch {
      continue;
    }
    for (const version of versions) found.push(join(root, version, 'libexec', 'llvm', 'bin', 'clang'));
  }
  found.push('wasm32-clang', 'clang');
  return found;
}

async function compile() {
  const output = join(OUT, 'game.wasm');
  const failures = [];
  for (const clang of await candidates()) {
    try {
      await run(clang, [...WASM_ARGS, '-o', output, join(SRC, 'game.c')]);
      return { clang, output };
    } catch (error) {
      failures.push(`${clang}: ${(error.stderr ?? error.message).toString().split('\n')[0]}`);
    }
  }
  const detail = failures.map((line) => `  ${line}`).join('\n');
  console.warn(`demo-app: no wasm-capable clang found, using prebuilt wasm\n${detail}`);
  return null;
}

await mkdir(OUT, { recursive: true });

const compiled = await compile();
if (compiled) {
  // Keep a committed copy so the demo still builds on machines without a wasm toolchain.
  await mkdir(PREBUILT, { recursive: true });
  await copyFile(compiled.output, join(PREBUILT, 'game.wasm'));
  console.log(`demo-app: compiled src/game.c with ${compiled.clang}`);
} else {
  await copyFile(join(PREBUILT, 'game.wasm'), join(OUT, 'game.wasm'));
}

await build({
  entryPoints: [
    join(SRC, 'demo.js'),
    join(SRC, 'worker-demo.js'),
    join(SRC, 'worker-game.js'),
    join(SRC, 'nested-demo.js'),
    join(SRC, 'nested-relay.js'),
  ],
  outdir: OUT,
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  legalComments: 'none',
});

for (const file of ['index.html', 'framed.html', 'worker.html', 'nested.html', 'styles.css']) {
  await copyFile(join(HERE, file), join(OUT, file));
}

if (!(await exists(join(OUT, 'game.wasm')))) {
  throw new Error('demo-app: no game.wasm produced');
}
console.log('demo-app -> packages/demo-app/out/');
