import { WebSocketServer, type WebSocket } from 'ws';
import {
  BridgeError,
  Events,
  isEvent,
  isResponse,
  makeRequest,
  type BridgeErrorShape,
} from '@wasmcheat/protocol';

/**
 * The local half of the bridge: a WebSocket server the extension dials into.
 *
 * The extension is the client because only it can reach browser tabs; the MCP server
 * therefore has to be the listener. One extension connection at a time; a newer one
 * replaces the older (a reloaded extension, a second browser).
 */

export interface BridgeOptions {
  host: string;
  port: number;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class Bridge {
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private waiters: Array<() => void> = [];
  private nextId = 1;
  private extensionVersion: string | null = null;
  readonly requestTimeoutMs: number;

  constructor(readonly options: BridgeOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = new WebSocketServer({ host: this.options.host, port: this.options.port });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.once('listening', () => {
        server.off('error', onError);
        resolve();
      });
    });
    server.on('error', (error) => {
      process.stderr.write(`[wasmcheat] bridge error: ${(error as Error).message}\n`);
    });
    server.on('connection', (socket) => this.accept(socket));
    this.server = server;
  }

  async stop(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  get version(): string | null {
    return this.extensionVersion;
  }

  on(event: string, listener: (data: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  /** Resolves once an extension says hello, or throws after `timeoutMs`. */
  waitForExtension(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== onReady);
        reject(
          new BridgeError(
            'NO_AGENT',
            `no WasmCheat extension connected to ws://${this.options.host}:${this.options.port} after ${timeoutMs}ms. ` +
              'Load packages/extension as an unpacked extension and keep this server running.',
          ),
        );
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onReady);
    });
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new BridgeError(
        'NO_AGENT',
        'the WasmCheat extension is not connected; load it in Chrome and keep the MCP server running',
      );
    }
    const id = `r${this.nextId++}`;
    const budget = Math.min(timeoutMs ?? this.requestTimeoutMs, 130_000);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('TIMEOUT', `${method} timed out after ${budget}ms`, { method }));
      }, budget);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      socket.send(JSON.stringify(makeRequest(id, method, params)));
    });
  }

  private accept(socket: WebSocket): void {
    if (this.socket && this.socket !== socket) {
      // A stale worker from before an extension reload: drop it instead of splitting traffic.
      try {
        this.socket.close(1000, 'replaced by a newer connection');
      } catch {
        // already gone
      }
    }
    this.socket = socket;
    process.stderr.write('[wasmcheat] extension connected\n');

    socket.on('message', (raw) => this.onMessage(raw));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.extensionVersion = null;
      this.rejectAll(new BridgeError('NO_AGENT', 'the extension disconnected from the bridge'));
      this.emit(Events.disconnected, { at: Date.now() });
      process.stderr.write('[wasmcheat] extension disconnected\n');
    });
    socket.on('error', () => {
      // 'close' follows and does the cleanup.
    });
  }

  private onMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (isResponse(parsed)) {
      const entry = this.pending.get(parsed.id);
      if (!entry) return;
      this.pending.delete(parsed.id);
      clearTimeout(entry.timer);
      if (parsed.error) entry.reject(fromShape(parsed.error));
      else entry.resolve(parsed.result);
      return;
    }

    if (isEvent(parsed)) {
      if (parsed.event === 'bridge.hello') {
        const data = parsed.data as { extension?: string } | null;
        this.extensionVersion = data?.extension ?? 'unknown';
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter();
      }
      this.emit(parsed.event, parsed.data);
    }
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(data);
      } catch {
        // A throwing listener must not kill the socket loop.
      }
    }
  }

  private rejectAll(error: BridgeError): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

function fromShape(shape: BridgeErrorShape): BridgeError {
  return new BridgeError(shape.code, shape.message, shape.detail);
}
