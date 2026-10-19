/**
 * The middle worker: it owns nothing but a child worker. Its only job is to prove that a worker
 * started from inside another worker is still captured — the page's `Worker` wrapper never sees
 * this constructor, so only the worker-scope wrapper can.
 */
let child = null;
let state = { score: 0, coins: 0, lives: 0, ready: false };

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.from === 'game') return;
  if (message.cmd === 'init') {
    child = new Worker('worker-game.js');
    child.addEventListener('message', (childEvent) => {
      const data = childEvent.data;
      if (!data || data.from !== 'game') return;
      state = data.state;
      // Every tick republishes the state, so readiness comes from the state itself, not a top-level flag.
      self.postMessage({ from: 'relay', state, status: state?.ready ? 'wasm ready (worker in a worker)' : 'starting game worker' });
    });
    child.addEventListener('error', (error) => {
      self.postMessage({ from: 'relay', status: `game worker error: ${error.message}` });
    });
    child.postMessage({ cmd: 'init', wasm: message.wasm });
    return;
  }
  if (!child) return;
  child.postMessage(message);
});
