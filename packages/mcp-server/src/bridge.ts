import { WebSocketServer, type WebSocket } from 'ws';
import {
  BRIDGE_PAIR,
  BridgeError,
  Events,
  PROTOCOL_VERSION,
  isRequest,
  makeErrorResponse,
  makeResponse,
  isEvent,
  isResponse,
  makeRequest,
  type BridgeErrorShape,
  type EventMessage,
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
  /**
   * How long a request waits for the extension to (re)connect before giving up. MV3 suspends the
   * service worker after ~30s idle and it dials back in on its own, so the first call after a pause
   * is routinely racing that reconnect; failing instantly turned a healthy setup into a scary error.
   */
  reconnectGraceMs?: number;
  /**
   * Shared secret the extension must present in its `bridge.hello`. Without it any local process —
   * or any page that guesses the port — could connect and answer this server's tool calls with
   * invented data. When omitted the bridge refuses to authenticate anyone, which is only useful in
   * a unit test.
   */
  token?: string;
  /**
   * Allow an extension on this machine to fetch the token over the loopback socket instead of being
   * given it by hand. This is trust-on-first-use between processes of the same user: whoever
   * connects first gets the token, which is the same authority as reading the file on disk. Set to
   * false (`WASMCHEAT_PAIRING=off`) when the token is a deliberate secret.
   */
  pairing?: boolean;
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
  /** Sockets that have presented the token. A socket that has not is never used for requests. */
  private readonly authenticated = new WeakSet<object>();
  /**
   * The socket that currently holds the token. Pairing is offered only while no live socket is
   * authenticated, so a process cannot take over a running bridge, while an extension that dropped
   * its own socket (a restart, a reinstall, a wiped token) can still ask for the token again.
   */
  private authenticatedSocket: WebSocket | null = null;
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
    return this.socket?.readyState === 1 && this.authenticated.has(this.socket);
  }

  /** The port actually bound, so a test can ask for an ephemeral one by passing 0. */
  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
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
    // A socket that is open but unauthenticated is a configuration problem: waiting cannot fix it.
    if (this.socket && this.socket.readyState === 1 && !this.authenticated.has(this.socket)) {
      throw new BridgeError(
        'NO_AGENT',
        'the WasmCheat extension connected but has not presented a valid bridge token; paste the token from ~/.wasmcheat/token into the extension panel',
      );
    }
    const grace = this.options.reconnectGraceMs ?? 0;
    if ((!this.socket || this.socket.readyState !== 1) && grace > 0) {
      await this.waitForExtension(grace).catch(() => undefined);
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.authenticated.has(socket)) {
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

  /**
   * Push an event to the extension. This is the only direction the server has ever spoken
   * unprompted (the audit mirror), so it is a no-op rather than an error when no extension is
   * connected: the human opening the panel later gets the buffer the extension kept, if any.
   */
  send(event: string, data: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const message: EventMessage = { v: PROTOCOL_VERSION, kind: 'evt', event, data };
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A socket that died between the check and the send is closed by its 'close' handler.
    }
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
      if (this.authenticatedSocket === socket) this.authenticatedSocket = null;
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

    if (isRequest(parsed)) {
      this.onRequest(parsed.id, parsed.method, parsed.params);
      return;
    }

    if (isEvent(parsed)) {
      if (parsed.event === 'bridge.hello') {
        const data = parsed.data as { extension?: string; token?: unknown } | null;
        if (!this.checkToken(data?.token)) {
          // Refuse the socket and say so on stderr: a wrong token is a configuration problem a human
          // has to see, not something to retry silently.
          process.stderr.write('[wasmcheat] rejected an extension connection: bad bridge token\n');
          this.emit('bridge.unauthorized', { at: Date.now() });
          try {
            this.socket?.close(1008, 'bad bridge token');
          } catch {
            // already gone
          }
          return;
        }
        this.authenticated.add(this.socket as object);
        this.authenticatedSocket = this.socket;
        this.extensionVersion = data?.extension ?? 'unknown';
        process.stderr.write('[wasmcheat] extension authenticated\n');
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter();
      }
      this.emit(parsed.event, parsed.data);
    }
  }

  /**
   * The extension is the client, so a request from it is unusual: pairing is the only one. It is
   * answered once per socket and refuses once anything is authenticated, so a second process cannot
   * take over a bridge that is already in use.
   */
  private onRequest(id: string, method: string, _params: unknown): void {
    if (method !== BRIDGE_PAIR) {
      this.reply(id, makeErrorResponse(id, new BridgeError('UNSUPPORTED', `unknown request "${method}"`)));
      return;
    }
    // A paired socket that has already gone away must not block a fresh install (or an extension
    // reload, which drops its token) from pairing again.
    const pairedAlive = this.authenticatedSocket !== null && this.authenticatedSocket.readyState === 1;
    const allowed = this.options.pairing !== false && !pairedAlive;
    if (!allowed || !this.options.token) {
      this.reply(
        id,
        makeErrorResponse(
          id,
          new BridgeError(
            'UNSUPPORTED',
            this.options.pairing === false
              ? 'pairing is disabled on this server; paste the token from ~/.wasmcheat/token into the WasmCheat panel'
              : 'this bridge is already paired with another extension',
          ),
        ),
      );
      return;
    }
    process.stderr.write('[wasmcheat] an extension paired over the loopback socket\n');
    this.reply(id, makeResponse(id, { token: this.options.token, paired: true }));
  }

  private reply(id: string, message: unknown): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      // The socket died between the request and the answer; 'close' handles the rest.
    }
  }

  /** Constant-time-ish comparison: length differs rarely and the values are short. */
  private checkToken(presented: unknown): boolean {
    const expected = this.options.token;
    if (!expected) return false;
    if (typeof presented !== 'string') return false;
    if (presented.length !== expected.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index += 1) {
      diff |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
    }
    return diff === 0;
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
