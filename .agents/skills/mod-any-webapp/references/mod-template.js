// A kept mod (wasmcheat_mod add): it runs in the game frame on every load, before the game exists.
// Helpers every script gets: until(check, timeoutMs, everyMs) and wasm(id = 'latest').
if (window.__wasmcheatMod) return 'already on'; // a second delivery in the same page

// 1. Wait for what the mod needs. JS engine: the app object. Memory game: the instance, then the
//    values found by name (see references/routes.md), because addresses move between loads.
const app = await until(() => window.pc?.app ?? null, 60_000);

// 2. State and actions: every feature is a switch or a one-shot action, so the HUD and an agent drive
//    the same functions through window.__wasmcheatMod.
const state = { featureA: true };
const actions = {
  featureA: () => { state.featureA = !state.featureA; },
  oneShot: () => { /* change something once */ },
};

// 3. Hook the game: wrap its functions, swap its listeners, or write memory on a timer. Validate before
//    every memory write, and do nothing on a tick where no switch is on.

// 4. A HUD in the frame, styled inline so the game's CSS cannot reach it, that keeps clicks off the game.
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;display:flex;flex-direction:column;gap:4px;font:12px/1.2 system-ui,sans-serif;color:#fff;background:rgb(0 0 0 / 55%);padding:8px;border-radius:8px;user-select:none';
const rows = [['Feature A', 'featureA', true], ['Do it once', 'oneShot', false]];
for (const [label, action, toggle] of rows) {
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'all:unset;cursor:pointer;padding:3px 6px;border-radius:5px';
  const paint = () => {
    button.textContent = `${label}${toggle ? (state[action] ? '  on' : '  off') : ''}`;
    button.style.background = toggle && state[action] ? 'rgb(56 195 164 / 55%)' : 'rgb(255 255 255 / 12%)';
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) button.addEventListener(type, (event) => event.stopPropagation());
  button.addEventListener('click', (event) => { event.stopPropagation(); actions[action](); paint(); });
  paint();
  hud.append(button);
}
document.body.append(hud);

window.__wasmcheatMod = { state, actions };
return 'mod on: Feature A, Do it once';
