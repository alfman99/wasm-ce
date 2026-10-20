import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BRIDGE_CHALLENGE,
  BRIDGE_HELLO,
  BRIDGE_NONCE,
  BRIDGE_PAIR,
  BRIDGE_WELCOME,
  bridgeProofInput,
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
 * replaces the older (a reloaded extension, a second browser) only once it proves it holds the
 * token, so a connection that cannot authenticate never disturbs the one in use. The handshake is
 * mutual and never sends the token (see `BRIDGE_CHALLENGE` in @wasmcheat/protocol): the extension
 * also checks this server, so a stand-in on the port while this one is down gets nothing.
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
   * Shared secret both ends prove they hold during the handshake, without sending it. Without it
   * any local process could connect and answer this server's tool calls with invented data. When
   * omitted the bridge refuses to authenticate anyone, which is only useful in a unit test.
   */
  token?: string;
  /**
   * Allow an extension on this machine to fetch the token over the loopback socket instead of being
   * given it by hand. This is trust-on-first-use: the token goes to whoever asks while no
   * authenticated socket is connected, and never while one is, so a running bridge cannot be taken
   * over. Web pages are refused at the upgrade (their Origin is not `chrome-extension://`). Set to
   * false (`WASMCHEAT_PAIRING=off`) when the token is a deliberate secret.
   */
  pairing?: boolean;
  /** Where the token lives, for error messages that tell a human what to paste. */
  tokenPath?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  socket: WebSocket;
}

export class Bridge {
  private server: WebSocketServer | null = null;
  /**
   * The socket that proved it holds the token, and the only one requests go to or anything is accepted
   * from. It is cleared on its 'close', not when it starts closing, so pairing stays refused until
   * it is really gone, while an extension that dropped its own socket (a restart, a reinstall, a
   * wiped token) can still ask for the token again. Unauthenticated sockets are never stored here.
   */
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  /** The nonce each socket was challenged with, until its one hello uses it up. */
  private readonly challenges = new WeakMap<WebSocket, string>();
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
    const server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      // The extension sends `chrome-extension://<id>`; Node clients (tests, scripts) send none. A web
      // page always sends its own origin, so refusing every other one keeps pages off the socket.
      verifyClient: ({ origin }: { origin?: string }) => !origin || origin.startsWith('chrome-extension://'),
    });
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
    const server = this.server;
    this.server = null;
    // `server.close` waits for every client, authenticated or not.
    for (const client of server?.clients ?? []) client.terminate();
    this.socket = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
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
    // An open socket that has not said hello yet is usually mid-handshake (pairing, then hello), so
    // it gets the same grace as a reconnect.
    const grace = this.options.reconnectGraceMs ?? 0;
    if (!this.connected && grace > 0) {
      await this.waitForExtension(grace).catch(() => undefined);
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      const waiting = [...(this.server?.clients ?? [])].some((client) => client.readyState === 1);
      throw new BridgeError(
        'NO_AGENT',
        waiting
          ? `the WasmCheat extension connected but has not presented a valid bridge token; paste the token from ${this.tokenPath} into the extension panel`
          : 'the WasmCheat extension is not connected; load it in Chrome and keep the MCP server running',
      );
    }
    const id = `r${this.nextId++}`;
    const budget = Math.min(timeoutMs ?? this.requestTimeoutMs, 130_000);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('TIMEOUT', `${method} timed out after ${budget}ms`, { method }));
      }, budget);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method, socket });
      socket.send(JSON.stringify(makeRequest(id, method, params)));
    });
  }

  /**
   * Push an event to the authenticated extension. This is the only direction the server has ever
   * spoken unprompted (the audit mirror), so it is a no-op rather than an error when no extension is
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

  private get tokenPath(): string {
    return this.options.tokenPath ?? '~/.wasmcheat/token';
  }

  private accept(socket: WebSocket): void {
    process.stderr.write('[wasmcheat] extension connected\n');

    socket.on('message', (raw) => this.onMessage(socket, raw));
    socket.on('close', () => {
      // Requests sent on this socket can never be answered, whether or not it was still current.
      this.rejectPending(socket, new BridgeError('NO_AGENT', 'the extension disconnected from the bridge'));
      if (this.socket !== socket) return;
      this.socket = null;
      this.extensionVersion = null;
      this.emit(Events.disconnected, { at: Date.now() });
      process.stderr.write('[wasmcheat] extension disconnected\n');
    });
    socket.on('error', () => {
      // 'close' follows and does the cleanup.
    });
    const nonce = randomBytes(16).toString('hex');
    this.challenges.set(socket, nonce);
    this.reply(socket, { v: PROTOCOL_VERSION, kind: 'evt', event: BRIDGE_CHALLENGE, data: { nonce } });
  }

  private onMessage(socket: WebSocket, raw: unknown): void {
    // A socket we already closed (replaced, refused) has nothing more to say.
    if (socket.readyState !== 1) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (isRequest(parsed)) {
      this.onRequest(socket, parsed.id, parsed.method);
      return;
    }

    if (isEvent(parsed) && parsed.event === BRIDGE_HELLO) {
      this.onHello(socket, parsed.data);
      return;
    }

    // Everything else (answers, page events, audit lines) is only believed from the socket that
    // proved it holds the token: anything else on the port could invent it.
    if (socket !== this.socket) return;

    if (isResponse(parsed)) {
      const entry = this.pending.get(parsed.id);
      if (!entry || entry.socket !== socket) return;
      this.pending.delete(parsed.id);
      clearTimeout(entry.timer);
      if (parsed.error) entry.reject(fromShape(parsed.error));
      else entry.resolve(parsed.result);
      return;
    }

    if (isEvent(parsed)) this.emit(parsed.event, parsed.data);
  }

  private onHello(socket: WebSocket, raw: unknown): void {
    const data = raw as { extension?: string; nonce?: unknown; proof?: unknown } | null;
    // One hello per challenge: a socket cannot retry proofs against the same nonce.
    const challenge = this.challenges.get(socket);
    this.challenges.delete(socket);
    const nonce = typeof data?.nonce === 'string' && BRIDGE_NONCE.test(data.nonce) ? data.nonce : null;
    if (!challenge || !nonce || !this.checkProof(data?.proof, this.proof('ext', challenge, nonce))) {
      // Refuse the socket and say so on stderr: a wrong token is a configuration problem a human
      // has to see, not something to retry silently.
      process.stderr.write('[wasmcheat] rejected an extension connection: bad bridge token\n');
      this.emit('bridge.unauthorized', { at: Date.now() });
      try {
        socket.close(1008, 'bad bridge token');
      } catch {
        // already gone
      }
      return;
    }
    const previous = this.socket;
    if (previous && previous !== socket) {
      // A stale worker from before an extension reload: drop it instead of splitting traffic.
      this.rejectPending(previous, new BridgeError('NO_AGENT', 'the extension reconnected on a new socket'));
      try {
        previous.close(1000, 'replaced by a newer connection');
      } catch {
        // already gone
      }
    }
    // The welcome goes out before any request can: the extension runs nothing until it checks out.
    this.reply(socket, {
      v: PROTOCOL_VERSION,
      kind: 'evt',
      event: BRIDGE_WELCOME,
      data: { proof: this.proof('srv', challenge, nonce) },
    });
    this.socket = socket;
    this.extensionVersion = data?.extension ?? 'unknown';
    process.stderr.write('[wasmcheat] extension authenticated\n');
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
    this.emit(BRIDGE_HELLO, raw);
  }

  /**
   * The extension is the client, so a request from it is unusual: pairing is the only one. It is
   * refused while an authenticated socket exists, so a second process cannot take over a bridge
   * that is already in use.
   */
  private onRequest(socket: WebSocket, id: string, method: string): void {
    if (method !== BRIDGE_PAIR) {
      if (socket === this.socket) {
        this.reply(socket, makeErrorResponse(id, new BridgeError('UNSUPPORTED', `unknown request "${method}"`)));
      }
      return;
    }
    const holder = this.socket;
    if (holder && holder !== socket && holder.readyState === 2 && this.options.pairing !== false) {
      // The holder is already leaving (a restarting extension closes before it redials): answer once
      // it is really gone instead of refusing a re-pair that would succeed a moment later.
      holder.once('close', () => {
        if (socket.readyState === 1) this.onRequest(socket, id, method);
      });
      return;
    }
    // A paired socket that has already gone away must not block a fresh install (or an extension
    // reload, which drops its token) from pairing again.
    const allowed = this.options.pairing !== false && holder === null;
    if (!allowed || !this.options.token) {
      this.reply(
        socket,
        makeErrorResponse(
          id,
          new BridgeError(
            'UNSUPPORTED',
            this.options.pairing === false
              ? `pairing is disabled on this server; paste the token from ${this.tokenPath} into the WasmCheat panel`
              : 'this bridge is already paired with another extension',
          ),
        ),
      );
      return;
    }
    process.stderr.write('[wasmcheat] an extension paired over the loopback socket\n');
    this.reply(socket, makeResponse(id, { token: this.options.token, paired: true }));
  }

  private reply(socket: WebSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket died between the request and the answer; 'close' handles the rest.
    }
  }

  /** HMAC-SHA256 in hex; `bridgeProof` in @wasmcheat/protocol is the extension's WebCrypto twin. */
  private proof(role: 'ext' | 'srv', serverNonce: string, extensionNonce: string): string {
    return createHmac('sha256', this.options.token ?? '')
      .update(bridgeProofInput(role, serverNonce, extensionNonce))
      .digest('hex');
  }

  private checkProof(presented: unknown, expected: string): boolean {
    if (!this.options.token || typeof presented !== 'string') return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
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

  private rejectPending(socket: WebSocket, error: BridgeError): void {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

function fromShape(shape: BridgeErrorShape): BridgeError {
  return new BridgeError(shape.code, shape.message, shape.detail);
}
