// The demo target: a tiny clicker whose whole state lives in WebAssembly linear memory.
//
// Built with a plain `clang --target=wasm32` and loaded by hand (see src/demo.js) instead of
// through Emscripten's glue: the glue caches `wasmExports['get_score']` on first call, which
// would hide the very thing this project demonstrates: patching an export on a live instance.
//
// `volatile` keeps the compiler from promoting these to wasm globals; they must sit in the
// linear memory a Cheat Engine-style scanner can walk.

__attribute__((import_module("env"), import_name("log"))) extern void env_log(int value);

volatile int g_score = 0;
volatile int g_coins = 0;
volatile int g_lives = 5;
volatile int g_level = 1;
volatile int g_accumulator = 0;

__attribute__((export_name("tick"))) void tick(int elapsed_ms) {
  if (elapsed_ms < 0) return;
  g_accumulator += elapsed_ms;
  while (g_accumulator >= 200) {
    g_accumulator -= 200;
    g_score += 1;
  }
}

__attribute__((export_name("mine"))) void mine(void) {
  g_coins += 1;
  g_score += 25;
  env_log(g_coins);
}

__attribute__((export_name("take_damage"))) void take_damage(int amount) {
  if (amount <= 0) return;
  g_lives -= amount;
  if (g_lives <= 0) {
    g_lives = 0;
    g_level = 1;
  }
}

__attribute__((export_name("reset_game"))) void reset_game(void) {
  g_score = 0;
  g_coins = 0;
  g_lives = 5;
  g_level = 1;
  g_accumulator = 0;
}

__attribute__((export_name("get_score"))) int get_score(void) { return g_score; }
__attribute__((export_name("get_coins"))) int get_coins(void) { return g_coins; }
__attribute__((export_name("get_lives"))) int get_lives(void) { return g_lives; }
__attribute__((export_name("get_level"))) int get_level(void) { return g_level; }
