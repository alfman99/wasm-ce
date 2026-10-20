/**
 * Page side of the worker demo: it owns the UI and nothing else. The game lives in a worker, so
 * `window` has no `WebAssembly` instance to find, which is exactly the case this page exists to
 * exercise.
 */
const scoreOut = document.getElementById('score');
const coinsOut = document.getElementById('coins');
const statusOut = document.getElementById('status');

const worker = new Worker('worker-game.js');
let latest = { score: 0, coins: 0, lives: 0, ready: false };

worker.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.from !== 'game') return;
  latest = message.state;
  if (typeof message.state.score === 'number') {
    scoreOut.textContent = String(message.state.score);
    coinsOut.textContent = String(message.state.coins);
  }
  if (message.ready) statusOut.textContent = 'wasm ready (in a worker)';
});

worker.addEventListener('error', (event) => {
  statusOut.textContent = `worker error: ${event.message}`;
});

worker.postMessage({ cmd: 'init', wasm: new URL('game.wasm', location.href).href });

document.getElementById('mine').addEventListener('click', () => worker.postMessage({ cmd: 'mine' }));
document.getElementById('damage').addEventListener('click', () => worker.postMessage({ cmd: 'damage' }));
document.getElementById('reset').addEventListener('click', () => worker.postMessage({ cmd: 'reset' }));

/** Test hook: the values the worker last reported, without touching worker memory. */
window.__foundryWorker = {
  snapshot: () => ({ ...latest }),
};
