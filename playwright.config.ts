import { defineConfig } from '@playwright/test';

/**
 * One worker, serial tests: the suite drives a single real browser with the extension
 * loaded, a real demo server and a real MCP server process, so parallel runs would fight
 * over the bridge port.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // The screenshot run writes docs/img/*.png and is only wanted on demand.
  testIgnore: process.env.WASMCHEAT_SHOTS ? [] : ['**/screenshots.spec.ts', '**/promo.spec.ts'],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
