/**
 * Page side of the nested-worker demo: the page starts a worker, and that worker starts the game
 * worker. No wasm is instantiated in either of the two realms the page can see, which is the case
 * the nested-worker wrapper exists for.
 *
 * The relay worker only forwards commands and state, so the page shows the game without ever
 * touching its memory.
 */
const scoreOut = document.getElementById('score');
const coinsOut = document.getElementById('coins');
const statusOut = document.getElementById('status');

const relay = new Worker('nested-relay.js');
let latest = { score: 0, coins: 0, lives: 0, ready: false };

relay.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.from !== 'relay') return;
  if (message.state) {
    latest = message.state;
    scoreOut.textContent = String(latest.score ?? 0);
    coinsOut.textContent = String(latest.coins ?? 0);
  }
  if (message.error) statusOut.textContent = `game error: ${message.error}`;
  else if (message.status) statusOut.textContent = message.status;
});

relay.addEventListener('error', (event) => {
  statusOut.textContent = `relay error: ${event.message}`;
});

relay.postMessage({ cmd: 'init', wasm: new URL('game.wasm', location.href).href });

document.getElementById('mine').addEventListener('click', () => relay.postMessage({ cmd: 'mine' }));
document.getElementById('damage').addEventListener('click', () => relay.postMessage({ cmd: 'damage' }));
document.getElementById('reset').addEventListener('click', () => relay.postMessage({ cmd: 'reset' }));

/** Test hook: what the relay last reported, without touching any worker memory. */
window.__foundryNested = {
  snapshot: () => ({ ...latest }),
};
