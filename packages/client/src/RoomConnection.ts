import {
  applyLocal,
  applyRemote,
  CLOSE,
  createSync,
  parseServerMessage,
  viewSong,
  type ClientMessage,
  type Cursor,
  type Op,
  type Peer,
  type ServerMessage,
  type Song,
  type SyncState,
} from '@duty-cycle/protocol';

/** The slice of the WebSocket API this uses, so tests can pass the `ws` package. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

export type RoomStatus = 'connecting' | 'live' | 'reconnecting' | 'full' | 'failed';

export interface RoomSnapshot {
  readonly status: RoomStatus;
  /** Null until the first welcome arrives. */
  readonly song: Song | null;
  readonly me: Peer | null;
  /** Everyone else in the room. */
  readonly peers: readonly Peer[];
}

export interface RoomConnectionOptions {
  url: string;
  room: string;
  name: string;
  /** Starts the room with this song if nobody has opened it yet. */
  seed?: Song;
  createSocket?: (url: string) => SocketLike;
  /** Base reconnect delay; doubles per failed attempt up to 8 s. */
  retryMs?: number;
}

const OPEN = 1;
const MAX_RETRY_MS = 8_000;

/**
 * A live connection to one room. Local edits apply instantly and are sent to
 * the server; the server's ordered ops come back and settle them (see sync.ts).
 * If the connection drops, it reconnects with backoff, takes the server's
 * snapshot, and resends any edits the server never confirmed.
 *
 * Shaped for React's useSyncExternalStore: subscribe() and getSnapshot().
 */
export class RoomConnection {
  private socket: SocketLike | null = null;
  private sync: SyncState | null = null;
  private me: Peer | null = null;
  private peers = new Map<string, Peer>();
  private status: RoomStatus = 'connecting';
  private cursor: Cursor | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private snapshot: RoomSnapshot = { status: 'connecting', song: null, me: null, peers: [] };
  private readonly listeners = new Set<() => void>();
  private readonly createSocket: (url: string) => SocketLike;

  constructor(private readonly options: RoomConnectionOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
  }

  connect(): void {
    if (this.closed) return;
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      const { room, name } = this.options;
      // After a drop, offer the last song the server confirmed. If the server
      // restarted and lost the room, the first player back restores it.
      const seed = this.sync?.confirmed ?? this.options.seed;
      this.send({ type: 'hello', room, name, ...(seed ? { seed } : {}) });
    };
    socket.onmessage = (event) => {
      const message = parseServerMessage(typeof event.data === 'string' ? event.data : String(event.data));
      if (message) this.receive(message);
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.handleClose(event.code);
    };
  }

  dispatch(ops: readonly Op[]): void {
    if (!this.sync || ops.length === 0) return;
    for (const op of ops) this.sendOp(op);
    this.emit();
  }

  setCursor(cursor: Cursor): void {
    this.cursor = cursor;
    if (this.status === 'live') this.send({ type: 'cursor', cursor });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Left the room');
  }

  /** Edits the server hasn't confirmed yet. */
  get pendingCount(): number {
    return this.sync?.pending.length ?? 0;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RoomSnapshot => this.snapshot;

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        // Anything still pending was never confirmed on the old connection. Ops
        // set values rather than adjust them, so resending is safe.
        const unconfirmed = this.sync?.pending.map((entry) => entry.op) ?? [];
        this.sync = createSync(message.song, message.seq);
        this.me = message.you;
        this.peers = new Map(message.peers.map((peer) => [peer.id, peer]));
        this.status = 'live';
        this.attempt = 0;
        for (const op of unconfirmed) this.sendOp(op);
        if (this.cursor) this.send({ type: 'cursor', cursor: this.cursor });
        break;
      }
      case 'op': {
        if (!this.sync || !this.me) return;
        const next = applyRemote(this.sync, message, this.me.id);
        if (!next) {
          // A gap in the sequence: reconnect and start again from a snapshot.
          this.socket?.close(4100, 'Out of sync');
          return;
        }
        this.sync = next;
        break;
      }
      case 'joined':
        this.peers.set(message.peer.id, message.peer);
        break;
      case 'left':
        this.peers.delete(message.id);
        break;
      case 'cursor': {
        const peer = this.peers.get(message.id);
        if (peer) this.peers.set(message.id, { ...peer, cursor: message.cursor });
        break;
      }
      case 'error':
        console.warn(`[duty-cycle] server: ${message.message}`);
        return;
    }
    this.emit();
  }

  private sendOp(op: Op): void {
    if (!this.sync) return;
    const { state, message } = applyLocal(this.sync, op);
    this.sync = state;
    if (this.status === 'live') this.send(message);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private handleClose(code: number): void {
    this.socket = null;
    if (this.closed) return;
    if (code === CLOSE.roomFull || code === CLOSE.badHello) {
      this.status = code === CLOSE.roomFull ? 'full' : 'failed';
      this.emit();
      return;
    }
    this.status = this.sync ? 'reconnecting' : 'connecting';
    this.emit();
    const base = this.options.retryMs ?? 500;
    const delay = Math.min(MAX_RETRY_MS, base * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private emit(): void {
    this.snapshot = {
      status: this.status,
      song: this.sync ? viewSong(this.sync) : null,
      me: this.me,
      peers: [...this.peers.values()],
    };
    for (const listener of this.listeners) listener();
  }
}
