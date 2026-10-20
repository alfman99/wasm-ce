// Bubble Tower 3D mod, kept by WasmCheat and run on every load of the game frame.
// A: aim line on hover. S: swap with the next bubble. C: cycle the bubble's colour.
// F: fireball now. N: a miss costs no shot. The score is left alone: the game reports it to YouTube.
const app = await until(() => {
  const root = window.pc?.app?.root;
  const gameplay = root?.findByName('GameplayContainer');
  return gameplay?.aimContainer && gameplay.script?.gameplayController && window.EventTypes ? window.pc.app : null;
});
if (window.__wasmcheatMod) return 'already on';

const gameplay = app.root.findByName('GameplayContainer');
const aim = gameplay.script.aimController;
const play = gameplay.script.gameplayController;
const level = gameplay.script.levelController;
const powerup = app.root.find((entity) => entity.script?.powerupButtonController)[0];
const state = { aim: true, noMissPenalty: true };

// A: the game's own aim line, which this build leaves off, as a hover preview that never fires.
let pointer = null;
app.mouse.on(pc.EVENT_MOUSEMOVE, (event) => { pointer = { x: event.x, y: event.y }; });
aim.maxPoints = 120;
aim.pointSpacing = 0.4;
aim.enabled = true;
app.off(EventTypes.INPUT_DOWN, aim.handleInputDown, aim);
app.off(EventTypes.INPUT_UP, aim.handleInputUp, aim);
const aimUpdate = aim.update;
aim.update = function (dt) {
  aimUpdate.call(this, dt);
  if (state.aim && pointer) this.findTargetTowerPoint(pointer);
  this.entity.currentAimingAngle = undefined;
};

// N: a turn that popped nothing counts as one that did, so the shot counter and the rows stay put.
app.off(EventTypes.TURN_FINISHED, level.handleTurnFinished, level);
app.on(EventTypes.TURN_FINISHED, (ok) => level.handleTurnFinished(state.noMissPenalty ? true : ok));

const bubble = () => (play.activeBubble?.isBubble?.() ? play.activeBubble : null);
const actions = {
  aim: () => { state.aim = !state.aim; return state.aim; },
  swap: () => {
    const active = bubble();
    if (!active || play.nextBubbleColor === undefined) return false;
    const current = active.getColor();
    active.setColor(play.nextBubbleColor);
    play.nextBubbleColor = current;
    app.fire(EventTypes.SET_NEXT_BUBBLE_COLOR, current);
    return true;
  },
  color: () => {
    const active = bubble();
    const colors = gameplay.getPossibleBubbleColors();
    if (!active || colors.length === 0) return false;
    active.setColor(colors[(colors.indexOf(active.getColor()) + 1) % colors.length]);
    return true;
  },
  fireball: () => {
    if (!powerup || powerup.powerupAvailable) return false;
    powerup.cooldown = 0.01;
    return true;
  },
  noMissPenalty: () => { state.noMissPenalty = !state.noMissPenalty; return state.noMissPenalty; },
};

// A small panel in the corner, so every switch is visible and clickable, not only a key.
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;display:flex;flex-direction:column;gap:4px;font:12px/1.2 system-ui,sans-serif;color:#fff;background:rgb(0 0 0 / 55%);padding:8px;border-radius:8px;user-select:none';
const rows = [
  ['A', 'Aim line', 'aim', true],
  ['S', 'Swap with next', 'swap', false],
  ['C', 'Change colour', 'color', false],
  ['F', 'Fireball now', 'fireball', false],
  ['N', 'Misses are free', 'noMissPenalty', true],
];
const buttons = {};
for (const [key, label, action, toggle] of rows) {
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'all:unset;cursor:pointer;padding:3px 6px;border-radius:5px;background:rgb(255 255 255 / 12%)';
  const paint = () => {
    button.textContent = `${key}  ${label}${toggle ? (state[action] ? '  on' : '  off') : ''}`;
    button.style.background = toggle && state[action] ? 'rgb(56 195 164 / 55%)' : 'rgb(255 255 255 / 12%)';
  };
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => { event.stopPropagation(); actions[action](); paint(); });
  buttons[key.toLowerCase()] = () => { actions[action](); paint(); };
  paint();
  hud.append(button);
}
document.body.append(hud);
window.addEventListener('keydown', (event) => {
  const run = buttons[event.key.toLowerCase()];
  if (run && !event.repeat && !event.metaKey && !event.ctrlKey) run();
});

window.__wasmcheatMod = { state, actions };
return 'Bubble Tower mod on: A aim, S swap, C colour, F fireball, N free misses';
