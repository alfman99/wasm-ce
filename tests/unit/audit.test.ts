import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { record, tail } from '../../packages/mcp-server/src/audit';

// The extension's audit lines are recorded without awaiting, so a read right after must still see
// every one of them, in the order they were reported (this raced on a slower CI disk).
it('a tail right after unawaited records sees every line, in order', async () => {
  process.env.WASMCHEAT_HOME = mkdtempSync(join(tmpdir(), 'wasmcheat-audit-'));
  for (let index = 0; index < 20; index++) void record({ kind: 'write', ok: true, summary: `line ${index}` });
  const lines = (await tail(50)).map((line) => (JSON.parse(line) as { summary: string }).summary);
  expect(lines).toEqual(Array.from({ length: 20 }, (_, index) => `line ${index}`));
});
