// The demo loads its wasm module by hand.
//
// No Emscripten glue on purpose: the glue caches `wasmExports['get_score']` on the first call,
// so a patched export would never be seen by the page. Reading `instance.exports[name]` on
// every call keeps the demo patchable, which is the whole point of the end-to-end test.

const els = {
  score: document.getElementById('score'),
  coins: document.getElementById('coins'),
  lives: document.getElementById('lives'),
  level: document.getElementById('level'),
  status: document.getElementById('status'),
  mine: document.getElementById('mine'),
  damage: document.getElementById('damage'),
  reset: document.getElementById('reset'),
};

let wasm = null;
let instance = null;
let lastFrame = 0;
let paused = false;
const log = [];

/** Every call goes through the exports object, so a hook installed by WasmCheat applies. */
function call(name, ...args) {
  const fn = wasm[name];
  if (typeof fn !== 'function') throw new Error(`missing wasm export "${name}"`);
  return fn(...args);
}

function paint() {
  if (!wasm) return;
  els.score.textContent = String(call('get_score'));
  els.coins.textContent = String(call('get_coins'));
  els.lives.textContent = String(call('get_lives'));
  els.level.textContent = String(call('get_level'));
}

function frame(now) {
  if (!wasm) return;
  const elapsed = lastFrame === 0 ? 0 : now - lastFrame;
  lastFrame = now;
  if (!paused) call('tick', Math.min(Math.round(elapsed), 250));
  paint();
  requestAnimationFrame(frame);
}

els.mine.addEventListener('click', () => {
  if (!wasm) return;
  call('mine');
  paint();
});

els.damage.addEventListener('click', () => {
  if (!wasm) return;
  call('take_damage', 1);
  paint();
});

els.reset.addEventListener('click', () => {
  if (!wasm) return;
  call('reset_game');
  paint();
});

async function start() {
  const imports = {
    env: {
      // The module's only import: called from mine() with the ore count.
      log: (coins) => {
        log.push(coins);
        if (log.length > 5) log.shift();
      },
    },
  };
  const { instance: created } = await WebAssembly.instantiateStreaming(fetch('game.wasm'), imports);

  instance = created;
  wasm = created.exports;

  const exportCount = Object.keys(wasm).length;
  els.status.textContent = `wasm ready · ${exportCount} exports · ${wasm.memory.buffer.byteLength} bytes of memory`;
  paint();
  requestAnimationFrame(frame);

  // Exposed so the end-to-end test can read live state without going through the UI.
  window.__foundry = {
    instance,
    exports: wasm,
    // Tests pause the tick so a scan targets a value that is not moving.
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    snapshot: () => ({
      score: call('get_score'),
      coins: call('get_coins'),
      lives: call('get_lives'),
      level: call('get_level'),
    }),
    log: () => log.slice(),
  };
  window.dispatchEvent(new CustomEvent('foundry-ready'));
}

start().catch((error) => {
  els.status.textContent = `wasm failed: ${error.message}`;
  console.error(error);
});
