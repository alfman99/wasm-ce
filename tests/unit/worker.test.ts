import { describe, expect, it } from 'vitest';
import type {
  InstanceInfo,
  ReadResult,
  ScanHit,
  ScanSummary,
  WorkerCallMessage,
  WorkerMessage,
  WorkerResultMessage,
} from '../../packages/protocol/src/index';
import { PageRuntime } from '../../packages/page-agent/src/runtime';
import { WorkerAgent } from '../../packages/page-agent/src/worker';
import { buildStoreModule } from '../helpers/wasm-builder';

/**
 * The worker agent is driven directly, with `post` as an array: no real Worker is needed to prove
 * that a worker realm answers `page.*` calls, and that its ids come back namespaced.
 */
interface WorkerHarness {
  agent: WorkerAgent;
  outbox: WorkerMessage[];
}

function makeWorker(workerId = 'k1'): WorkerHarness {
  const outbox: WorkerMessage[] = [];
  const agent = new WorkerAgent({ workerId, post: (message) => outbox.push(message) });
  return { agent, outbox };
}

async function replyTo(harness: WorkerHarness, method: string, params: unknown = {}): Promise<WorkerResultMessage> {
  await harness.agent.handleMessage({ __wasmcheat: 'call', id: `call-${harness.outbox.length + 1}`, method, params });
  const reply = harness.outbox.at(-1);
  if (!reply || reply.__wasmcheat !== 'result') throw new Error(`no result for ${method}`);
  return reply;
}

function value<T>(reply: WorkerResultMessage): T {
  if (reply.error) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as T;
}

/** The store module writes 1 at 0x10 and 2 at 0x20 the first time `tick` runs. */
async function instantiateStoreModule(): Promise<void> {
  const { instance } = await WebAssembly.instantiate(buildStoreModule(), {});
  (instance.exports.tick as () => void)();
}

/** A page runtime with one fake worker: `post` is captured, and answers are pushed back by hand. */
interface PageHarness {
  runtime: PageRuntime;
  sent: WorkerCallMessage[];
  respondWith(responder: ((message: WorkerCallMessage) => unknown) | null): void;
}

function makePage(): PageHarness {
  const runtime = new PageRuntime();
  runtime.install();
  const sent: WorkerCallMessage[] = [];
  let responder: ((message: WorkerCallMessage) => unknown) | null = null;
  runtime.addWorker({
    id: 'k1',
    url: 'http://localhost:4174/engine.worker.js',
    type: 'classic',
    post: (message) => {
      if (message.__wasmcheat !== 'call') return; // the hello probe: nothing to answer
      sent.push(message);
      if (!responder) return;
      runtime.handleWorkerMessage('k1', {
        __wasmcheat: 'result',
        id: message.id,
        result: responder(message),
      });
    },
  });
  return {
    runtime,
    sent,
    respondWith: (next) => {
      responder = next;
    },
  };
}

describe('worker agent', () => {
  it('answers the hello probe before it holds any instance', async () => {
    const harness = makeWorker();
    await harness.agent.handleMessage({ __wasmcheat: 'hello' });

    const reply = harness.outbox.at(-1);
    expect(reply?.__wasmcheat).toBe('hello');
    if (!reply || reply.__wasmcheat !== 'hello' || !('info' in reply)) throw new Error('not a hello reply');
    expect(reply.info.instances).toBe(0);
    expect(reply.info.version).toBe('0.1.0');
  });

  it('ignores messages that are not its own', async () => {
    const harness = makeWorker();
    await harness.agent.handleMessage({ move: 'left' });
    await harness.agent.handleMessage(null);
    expect(harness.outbox).toHaveLength(0);
  });

  it('tags the instances of its realm with the worker id it was handed', async () => {
    const harness = makeWorker();
    await instantiateStoreModule();

    const instances = value<InstanceInfo[]>(await replyTo(harness, 'page.listInstances'));
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ id: 'k1-1', host: 'worker', workerId: 'k1' });
    expect(instances[0]?.memory?.byteLength).toBe(65536);
  });

  it('reads memory through a k1-1 address', async () => {
    const harness = makeWorker();
    await instantiateStoreModule();

    const result = value<ReadResult>(
      await replyTo(harness, 'page.read', {
        address: { instanceId: 'k1-1', offset: 0x20 },
        type: 'i32',
      }),
    );
    expect(result.values).toEqual([2]);
    expect(result.address).toEqual({ instanceId: 'k1-1', offset: 0x20 });
  });

  it('namespaces the scan it mints and keeps the addresses it reports routable', async () => {
    const harness = makeWorker();
    await instantiateStoreModule();

    const summary = value<ScanSummary>(
      await replyTo(harness, 'page.scan.begin', {
        instanceId: 'k1-1',
        type: 'i32',
        mode: 'exact',
        value: 2,
      }),
    );
    expect(summary.scanId).toBe('k1-s1');
    expect(summary.matchCount).toBe(1);
    expect(summary.sample[0]?.address).toEqual({ instanceId: 'k1-1', offset: 0x20 });

    const page = value<{ hits: ScanHit[]; total: number }>(
      await replyTo(harness, 'page.scan.results', { scanId: 'k1-s1', offset: 0, limit: 5 }),
    );
    expect(page.total).toBe(1);
    expect(page.hits[0]?.address).toEqual({ instanceId: 'k1-1', offset: 0x20 });
    expect(page.hits[0]?.value).toBe(2);
  });

  it('answers a bad id with a bridge error instead of throwing at the caller', async () => {
    const harness = makeWorker();
    const reply = await replyTo(harness, 'page.read', { address: { instanceId: 'k1-9', offset: 0 }, type: 'i32' });
    expect(reply.error?.code).toBe('NO_INSTANCE');
    expect(reply.error?.message).toContain('k1-9');
  });
});

describe('page routing to workers', () => {
  it('forwards a call whose id belongs to a worker', async () => {
    const page = makePage();
    page.respondWith((message) => ({
      address: message.params,
      type: 'i32',
      values: [42],
    }));

    const result = await page.runtime.handle('page.read', {
      address: { instanceId: 'k1-1', offset: 4 },
      type: 'i32',
    });

    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]?.method).toBe('page.read');
    expect(result).toMatchObject({ values: [42] });
  });

  it('routes session ids the same way as instance ids', async () => {
    const page = makePage();
    page.respondWith(() => []);

    await page.runtime.handle('page.scan.results', { scanId: 'k1-s1', offset: 0, limit: 1 });

    expect(page.sent[0]?.method).toBe('page.scan.results');
  });

  it('keeps ids without a worker prefix in this realm', async () => {
    const page = makePage();
    page.respondWith(() => {
      throw new Error('a page id must never reach a worker');
    });

    await expect(
      page.runtime.handle('page.read', { address: { instanceId: 'w1', offset: 0 }, type: 'i32' }),
    ).rejects.toMatchObject({ code: 'NO_INSTANCE' });
    expect(page.sent).toHaveLength(0);
  });

  it('merges worker instances into the page listing', async () => {
    const page = makePage();
    page.respondWith(() => [
      {
        id: 'k1-1',
        moduleHash: 'abc',
        createdBy: 'instantiate',
        memoryResolved: true,
        memory: { byteLength: 65536, maxByteLength: null, growable: true },
        exports: [],
        createdAt: Date.now(),
        importPatchability: 'live',
        host: 'worker',
        workerId: 'k1',
      },
    ]);

    const instances = (await page.runtime.handle('page.listInstances', {})) as InstanceInfo[];
    expect(instances.map((instance) => instance.id)).toEqual(['k1-1']);
    expect(await page.runtime.handle('page.listWorkers', {})).toEqual([
      { id: 'k1', url: 'http://localhost:4174/engine.worker.js', type: 'classic', instances: 1 },
    ]);
  });

  it('times out instead of hanging when a worker never answers', async () => {
    const page = makePage();
    await expect(page.runtime.workerCall('k1', 'page.hello', {}, 20)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('says a terminated worker is gone, and names it', async () => {
    const page = makePage();
    page.runtime.removeWorker('k1');

    const error = await page.runtime
      .handle('page.read', { address: { instanceId: 'k1-1', offset: 0 }, type: 'i32' })
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'NO_INSTANCE' });
    expect((error as { message: string }).message).toContain('k1');
    expect(page.sent).toHaveLength(0);
    expect(await page.runtime.listWorkers()).toEqual([]);
  });
});
