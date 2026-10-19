/**
 * Worker-side game host: instantiate the module here, tick it here, and keep the page ignorant of
 * the memory. This is the shape Unity, Godot 4 and most itch.io builds use, and the reason a memory
 * tool that only watches the page realm reports "no wasm" on them.
 *
 * Every message the page agent sends is tagged with `__wasmcheat`, so this file can ignore any
 * message it does not own and the agent can ignore ours.
 */

let exportsRef = null;
let timer = null;
let log = [];

function state() {
  if (!exportsRef) return { score: 0, coins: 0, lives: 0, ready: false };
  return {
    score: exportsRef.get_score(),
    coins: exportsRef.get_coins(),
    lives: exportsRef.get_lives(),
    ready: true,
  };
}

function publish() {
  self.postMessage({ from: 'game', state: state(), log });
  log = [];
}

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || '__wasmcheat' in message) return;

  if (message.cmd === 'init') {
    const response = await fetch(message.wasm);
    const { instance } = await WebAssembly.instantiateStreaming(response, {
      env: { log: (value) => log.push(value) },
    });
    exportsRef = instance.exports;
    self.postMessage({ from: 'game', state: state(), log, ready: true });
    if (timer === null) {
      timer = setInterval(() => {
        exportsRef.tick(200);
        publish();
      }, 200);
    }
    return;
  }

  if (!exportsRef) return;
  switch (message.cmd) {
    case 'mine':
      exportsRef.mine();
      break;
    case 'damage':
      exportsRef.take_damage(1);
      break;
    case 'reset':
      exportsRef.reset_game();
      break;
    default:
      break;
  }
  publish();
});
