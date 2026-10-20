import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageRuntime } from '../../packages/page-agent/src/runtime';
import { MemoryAccess } from '../../packages/page-agent/src/memory';
import { buildMemoryModule } from '../helpers/wasm-builder';

async function instantiate(runtime: PageRuntime): Promise<{ id: string; access: MemoryAccess }> {
  await WebAssembly.instantiate(buildMemoryModule(), {});
  const tracked = runtime.registry.list().at(-1)!;
  return { id: tracked.id, access: new MemoryAccess(tracked.memory!) };
}

describe('PageRuntime freezes and watches', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins "latest" when a freeze or watch is created, so a new instance does not take it over', async () => {
    const runtime = new PageRuntime();
    runtime.install();
    const first = await instantiate(runtime);
    vi.useFakeTimers();
    const freeze = runtime.freezeSet({ address: { instanceId: 'latest', offset: 0x10 }, type: 'i32', value: 7 });
    const watch = runtime.watchAdd({ address: { instanceId: 'latest', offset: 0x10 }, type: 'i32' });
    expect(freeze.address.instanceId).toBe(first.id);
    expect(watch.address.instanceId).toBe(first.id);

    const second = await instantiate(runtime);
    vi.advanceTimersByTime(100);
    expect(first.access.read(0x10, 'i32')).toBe(7);
    expect(second.access.read(0x10, 'i32')).toBe(0);
    runtime.dispose();
  });

  it('does not log a watch event every tick for a value that stays NaN', async () => {
    const runtime = new PageRuntime();
    runtime.install();
    const { id, access } = await instantiate(runtime);
    access.write(0x20, 'f32', Number.NaN);
    vi.useFakeTimers();
    runtime.watchAdd({ address: { instanceId: id, offset: 0x20 }, type: 'f32' });
    vi.advanceTimersByTime(500);
    expect(runtime.watchPoll({})).toEqual([]);
    runtime.dispose();
  });
});
