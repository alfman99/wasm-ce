// Stealth Master mod, kept by WasmCheat and run on every load of the game frame.
// Everything is found by name on every load, because addresses move between loads:
// - saved values (coins, tokens) in the Unity Dictionary<string, int> that becomes the save;
// - classes, fields and live objects through IL2CPP's own runtime structures in memory.
if (window.__wasmcheatMod) return 'already on';
const game = await until(() => wasm()?.memory ?? null);
const view = () => ({ bytes: new Uint8Array(game.buffer), words: new Uint32Array(game.buffer), ints: new Int32Array(game.buffer), floats: new Float32Array(game.buffer) });

// IL2CPP metadata: its header starts with 0xFAB11BAF; names of classes and fields point into its string table.
function metadata() {
  const { words } = view();
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== 0xfab11baf) continue;
    const start = i * 4 + words[i + 6];
    return { lo: start, hi: start + words[i + 7] };
  }
  return null;
}
const strings = await until(metadata, 60_000, 1_000);
const named = (p) => p >= strings.lo && p < strings.hi;
function text(p) {
  const { bytes } = view();
  let s = '';
  for (let i = p; bytes[i] && s.length < 120; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

/** An Il2CppClass is {image, gc_desc, name*, namespace*, …}; its FieldInfos are {name*, type*, parent*, offset, token}. */
function findClass(name) {
  const { words, ints } = view();
  for (let i = 0; i + 3 < words.length; i += 1) {
    if (!named(words[i + 2]) || !named(words[i + 3]) || text(words[i + 2]) !== name || text(words[i + 3]) !== '') continue;
    const klass = i * 4;
    for (let w = 4; w < 40; w += 1) {
      const p = words[i + w];
      if (!p || p >= words.length * 4 - 20 || words[(p >> 2) + 2] !== klass || !named(words[p >> 2])) continue;
      const fields = {};
      for (let f = p; words[(f >> 2) + 2] === klass && named(words[f >> 2]); f += 20) fields[text(words[f >> 2])] = ints[(f >> 2) + 3];
      return { klass, fields };
    }
  }
  return null;
}

/** Live objects of a class: an Il2CppObject is {klass, monitor}, and the check keeps reused memory out. */
function objects(cls, check) {
  const { words } = view();
  const found = [];
  for (let i = 0; i < words.length; i += 2) if (words[i] === cls.klass && words[i + 1] === 0 && check(i * 4)) found.push(i * 4);
  return found;
}

// Classes and the fields this mod touches, by name. IL2CPP fills a class in the first time the game
// uses it, which for these is a mission, so they are looked for on each tick until found rather than
// awaited: the HUD and the saved values work from the menu.
const types = { stats: null, character: null };
function resolve() {
  types.stats ??= findClass('PlayerStatsHandler');
  types.character ??= findClass('Character');
  return types.stats && types.character;
}

// Saved values: a dictionary entry is {hash, next, key*, value}; the key is a string {klass, monitor, length, UTF-16}.
const entries = new Map();
function savedSlots(name) {
  const { words, ints } = view();
  const known = entries.get(name);
  if (known?.length && known.every((slot) => words[slot.key] === slot.string)) return known;
  const first = name.charCodeAt(0) | (name.charCodeAt(1) << 16);
  const keys = new Set();
  for (let i = 3; i < words.length; i += 1) {
    if (words[i] !== first || words[i - 1] !== name.length) continue;
    let same = true;
    for (let c = 2; c < name.length && same; c += 2) {
      const pair = name.charCodeAt(c) | ((c + 1 < name.length ? name.charCodeAt(c + 1) : 0) << 16);
      same = c + 1 < name.length ? words[i + c / 2] === pair : (words[i + c / 2] & 0xffff) === pair;
    }
    if (same) keys.add((i - 3) * 4);
  }
  const found = [];
  for (let i = 1; i + 1 < words.length && keys.size; i += 1) {
    if (keys.has(words[i]) && ints[i - 1] >= -1 && ints[i - 1] < 100_000) found.push({ key: i, value: i + 1, string: words[i] });
  }
  entries.set(name, found);
  return found;
}
const readSaved = (name) => { const [slot] = savedSlots(name); return slot ? view().ints[slot.value] : null; };
const writeSaved = (name, value) => { const { ints } = view(); for (const slot of savedSlots(name)) ints[slot.value] = value; };

const state = { coins: false, tokens: false, god: false, fast: false, coinsX: false };
/** Set when a switch was turned off, so the objects get their normal values back once. */
let restore = false;
const speeds = new Map();
const MAX = 99_999;
const isBool = (b) => b === 0 || b === 1;

function tick() {
  const { bytes, floats } = view();
  if (state.coins && readSaved('kCoins') < MAX) writeSaved('kCoins', MAX);
  if (state.tokens && readSaved('kTokens') < MAX) writeSaved('kTokens', MAX);
  if (!state.god && !state.fast && !state.coinsX && !restore) return 0;
  if (!resolve()) return 0;
  restore = false;
  const S = types.stats.fields, C = types.character.fields;
  const players = objects(types.stats, (a) => {
    const max = floats[(a + S._healthMax) >> 2], health = floats[(a + S._health) >> 2];
    return max >= 1 && max < 1e4 && health >= 0 && health <= max && isBool(bytes[a + S._godModeActivated]);
  });
  for (const a of players) {
    bytes[a + S._godModeActivated] = state.god ? 1 : 0;
    if (state.god) floats[(a + S._health) >> 2] = floats[(a + S._healthMax) >> 2];
    floats[(a + S._coinsMultiplier) >> 2] = state.coinsX ? 10 : 1;
  }
  const runners = objects(types.character, (a) => floats[(a + C.baseForwardSpeed) >> 2] > 1 && floats[(a + C.baseForwardSpeed) >> 2] < 100);
  for (const a of runners) {
    if (!speeds.has(a)) speeds.set(a, floats[(a + C.baseForwardSpeed) >> 2]);
    floats[(a + C.baseForwardSpeed) >> 2] = speeds.get(a) * (state.fast ? 1.8 : 1);
  }
  return players.length;
}

const actions = {
  god: () => { state.god = !state.god; restore = true; },
  fast: () => { state.fast = !state.fast; restore = true; },
  coinsX: () => { state.coinsX = !state.coinsX; restore = true; },
  coins: () => { state.coins = !state.coins; },
  tokens: () => { state.tokens = !state.tokens; },
  addCoins: () => writeSaved('kCoins', (readSaved('kCoins') ?? 0) + 1_000),
  addTokens: () => writeSaved('kTokens', (readSaved('kTokens') ?? 0) + 10),
};

const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;display:flex;flex-direction:column;gap:4px;font:12px/1.2 system-ui,sans-serif;color:#fff;background:rgb(0 0 0 / 55%);padding:8px;border-radius:8px;user-select:none';
const status = document.createElement('div');
status.style.cssText = 'padding:2px 6px;opacity:.85';
hud.append(status);
const rows = [
  ['God mode', 'god', true],
  ['Run faster', 'fast', true],
  ['x10 coins per mission', 'coinsX', true],
  ['Infinite coins', 'coins', true],
  ['+1000 coins', 'addCoins', false],
  ['Infinite tokens', 'tokens', true],
  ['+10 tokens', 'addTokens', false],
];
const painters = [];
for (const [label, action, toggle] of rows) {
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = 'all:unset;cursor:pointer;padding:3px 6px;border-radius:5px;background:rgb(255 255 255 / 12%)';
  painters.push(() => {
    button.textContent = `${label}${toggle ? (state[action] ? '  on' : '  off') : ''}`;
    button.style.background = toggle && state[action] ? 'rgb(56 195 164 / 55%)' : 'rgb(255 255 255 / 12%)';
  });
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) button.addEventListener(type, (event) => event.stopPropagation());
  button.addEventListener('click', (event) => { event.stopPropagation(); actions[action](); tick(); paint(); });
  hud.append(button);
}
function paint() {
  status.textContent = `Coins ${readSaved('kCoins') ?? '?'}   Tokens ${readSaved('kTokens') ?? '?'}`;
  for (const paintButton of painters) paintButton();
}
document.body.append(hud);
setInterval(() => { tick(); paint(); }, 1_000);
paint();

window.__wasmcheatMod = { state, actions, types, findClass, objects, readSaved, writeSaved };
return `Stealth Master mod on: coins ${readSaved('kCoins')}, tokens ${readSaved('kTokens')}, god mode, speed and x10 coins find their classes in a mission`;
