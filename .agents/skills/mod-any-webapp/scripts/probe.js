// First look at any page: pass this file as the `code` of wasmcheat_run_script (wasmcheat_guide
// returns it as the "probe" topic). It runs in the game frame and returns what the page added to `window` (a clean iframe is the baseline), which engines and
// frameworks it carries, its scripts, canvases and wasm, and whether it is a YouTube Playable.
const frame = document.createElement('iframe');
frame.style.display = 'none';
document.body.append(frame);
const baseline = new Set(Object.getOwnPropertyNames(frame.contentWindow));
frame.remove();
const own = Object.getOwnPropertyNames(window).filter((key) => !baseline.has(key) && key !== '__wasmcheat__');

const has = (name) => {
  try {
    return window[name] !== undefined;
  } catch {
    return false;
  }
};
const engines = {
  playcanvas: has('pc') && !!window.pc?.app,
  unity: has('createUnityInstance') || has('unityFramework') || has('unityInstance'),
  godot: has('Engine') && typeof window.Engine === 'function',
  emscripten: has('Module') && typeof window.Module === 'object',
  three: has('THREE'),
  babylon: has('BABYLON'),
  phaser: has('Phaser'),
  pixi: has('PIXI'),
  cocos: has('cc') && !!window.cc?.director,
  construct: has('C3') || has('cr_getC2Runtime'),
  defold: has('Module') && !!document.querySelector('#canvas[data-defold]'),
};
const root = document.querySelector('#root, #app, [data-reactroot], body > div');
const frameworks = {
  react: !!root && Object.keys(root).some((key) => key.startsWith('__reactContainer') || key.startsWith('__reactFiber')),
  vue: has('__VUE__') || !!document.querySelector('[data-v-app]'),
  svelte: [...document.querySelectorAll('*')].slice(0, 500).some((el) => [...el.classList].some((c) => c.startsWith('svelte-'))),
  angular: has('ng') || !!document.querySelector('[ng-version]'),
  redux: has('__REDUX_DEVTOOLS_EXTENSION__') || own.some((key) => /store/i.test(key)),
  nextjs: has('__NEXT_DATA__'),
};
const instance = wasm();
return {
  url: location.href,
  title: document.title,
  playable: has('ytgame') ? Object.keys(window.ytgame) : false,
  engines: Object.fromEntries(Object.entries(engines).filter(([, on]) => on)),
  frameworks: Object.fromEntries(Object.entries(frameworks).filter(([, on]) => on)),
  wasm: instance ? { id: instance.id, bytes: instance.memory?.buffer.byteLength ?? null, exports: Object.keys(instance.exports).length } : null,
  globals: own.slice(0, 150),
  scripts: [...document.scripts].map((script) => script.src || `inline: ${script.textContent.trim().slice(0, 80)}`),
  canvases: [...document.querySelectorAll('canvas')].map((canvas) => `${canvas.id || canvas.className || 'canvas'} ${canvas.width}x${canvas.height}`),
  storage: { local: Object.keys(localStorage).slice(0, 40), indexedDB: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((db) => db.name) : '?' },
};
