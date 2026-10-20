/**
 * The mod-any-webapp skill, served by the server itself so an agent needs nothing but the MCP
 * connection to follow it. build.mjs inlines the skill's files here; the skill folder stays the one
 * place they are written.
 */
declare const __WASMCHEAT_GUIDE__: Record<string, string> | undefined;

export const GUIDE: Record<string, string> = typeof __WASMCHEAT_GUIDE__ === 'undefined' ? {} : __WASMCHEAT_GUIDE__;

/** What a topic is for, shown in the tool's description and when a topic is unknown. */
export const GUIDE_TOPICS: Record<string, string> = {
  workflow: 'the whole method, step by step (start here)',
  routes: 'where state lives and how to reach it, per engine or framework',
  probe: 'script for wasmcheat_run_script: engine, framework, globals, wasm and storage of a page',
  il2cpp: 'script for wasmcheat_run_script: Unity IL2CPP classes, fields and objects from memory',
  'mod-template': 'starting point for a kept mod with an on-screen menu',
  'example-playcanvas': 'a complete mod for a PlayCanvas game (Bubble Tower 3D)',
  'example-unity': 'a complete mod for a Unity IL2CPP game (Stealth Master)',
};

/** Sent to every MCP client on connect: the loop in a paragraph, and where the rest is. */
export const INSTRUCTIONS =
  'WasmCheat reads and changes the web app or browser game open in the user\'s browser, through a browser ' +
  'extension. The loop: (1) wasmcheat_list_tabs, and pass tabId on every call; (2) wasmcheat_diagnose, then ' +
  'wasmcheat_run_script with the "probe" script from wasmcheat_guide to learn what the page is built with; ' +
  '(3) pick the route from wasmcheat_guide topic "routes": JavaScript objects for JS engines and web apps, the ' +
  'save for YouTube Playables, wasm memory (scan, or IL2CPP reflection for Unity) for compiled games; ' +
  '(4) change one thing live, read it back and ask the user what they see; (5) keep it with wasmcheat_mod add ' +
  'so it comes back on every load, finding everything by name since addresses move. Change only what the client ' +
  'owns: never scores reported to a platform, never multiplayer state; ask before writing a save that syncs. ' +
  'Call wasmcheat_guide with topic "workflow" for the full method.';
