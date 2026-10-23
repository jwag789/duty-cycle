import {
  applyLocal,
  applyRemote,
  ClockEstimator,
  CLOSE,
  confirmedSong,
  createSync,
  parseServerMessage,
  rowAt,
  sampleFromPing,
  settle,
  STOPPED,
  timeOfRow,
  viewSong,
  type ClientMessage,
  type Cursor,
  type Op,
  type Peer,
  type ServerMessage,
  type Song,
  type SyncState,
  type Transport,
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
  /** What the editor shows: everything, your unconfirmed edits included. Null until the first welcome. */
  readonly song: Song | null;
  /** What's being heard right now. Edits in `song` but not here are still waiting for their row. */
  readonly audible: Song | null;
  /** Ordered edits still waiting for their row in the current epoch, for the audio thread. */
  readonly queue: readonly { row: number; op: Op }[];
  readonly me: Peer | null;
  /** Everyone else in the room. */
  readonly peers: readonly Peer[];
  /** The room's shared playhead, in server time. */
  readonly transport: Transport;
  /** Null until the first ping comes back. */
  readonly clock: ClockStatus | null;
}

export interface ClockStatus {
  /** Server clock minus local clock, in ms, from the best sample. */
  readonly offset: number;
  /** Round trip of the best sample. */
  readonly rtt: number;
  readonly lastRtt: number | null;
  readonly samples: number;
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
  /** The local clock pings are timed with. */
  now?: () => number;
  /** Time between pings once the opening burst is done. */
  pingIntervalMs?: number;
}

const OPEN = 1;
const MAX_RETRY_MS = 8_000;
/** A quick burst on (re)connect gives a usable clock estimate within a few hundred ms. */
const PING_BURST = 6;
const PING_BURST_GAP_MS = 60;

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
  private transport: Transport = STOPPED;
  private readonly clock = new ClockEstimator();
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private pingsSent = 0;
  private snapshot: RoomSnapshot = {
    status: 'connecting',
    song: null,
    audible: null,
    queue: [],
    me: null,
    peers: [],
    transport: STOPPED,
    clock: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly now: () => number;

  constructor(private readonly options: RoomConnectionOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
    this.now = options.now ?? (() => performance.now());
  }

  connect(): void {
    if (this.closed) return;
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      const { room, name } = this.options;
      // After a drop, offer the last song the server confirmed. If the server
      // restarted and lost the room, the first player back restores it.
      const seed = this.sync ? confirmedSong(this.sync) : this.options.seed;
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

  /** Starts playback for the whole room. The server picks the moment. */
  play(fromRow = 0): void {
    if (this.status === 'live') this.send({ type: 'transport', action: 'play', fromRow });
  }

  stop(): void {
    if (this.status === 'live') this.send({ type: 'transport', action: 'stop' });
  }

  /** Best estimate of the server clock right now. */
  serverNow(): number {
    return this.now() + (this.clock.best?.offset ?? 0);
  }

  setCursor(cursor: Cursor): void {
    this.cursor = cursor;
    if (this.status === 'live') this.send({ type: 'cursor', cursor });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.stopPinging();
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
        this.sync = createSync(message.song, message.seq, message.scheduled);
        this.me = message.you;
        this.peers = new Map(message.peers.map((peer) => [peer.id, peer]));
        this.transport = message.transport;
        this.status = 'live';
        this.attempt = 0;
        for (const op of unconfirmed) this.sendOp(op);
        if (this.cursor) this.send({ type: 'cursor', cursor: this.cursor });
        // The server may have restarted with a different clock; start over.
        this.clock.reset();
        this.startPinging();
        break;
      }
      case 'pong':
        this.clock.add(sampleFromPing(message.t0, message.t, this.now()));
        break;
      case 'transport':
        this.transport = message.transport;
        break;
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
    this.settleDue();
    this.emit();
  }

  /**
   * Lands scheduled edits whose row is now being heard, then sets a timer for
   * the next one, so `audible` tracks what's coming out of the speakers.
   */
  private settleDue(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (!this.sync) return;

    const row = this.transport.playing ? Math.floor(rowAt(this.transport, this.serverNow())) : null;
    this.sync = settle(this.sync, this.transport, row);

    const next = this.sync.scheduled[0];
    if (next && this.transport.playing && next.epoch === this.transport.epoch) {
      const wait = timeOfRow(this.transport, next.row) - this.serverNow();
      this.settleTimer = setTimeout(() => {
        this.settleDue();
        this.emit();
      }, Math.max(0, wait));
    }
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

  private startPinging(): void {
    this.stopPinging();
    this.pingsSent = 0;
    const tick = () => {
      this.send({ type: 'ping', id: this.pingsSent, t0: this.now(), rtt: this.clock.best?.rtt ?? null });
      this.pingsSent++;
      const delay = this.pingsSent < PING_BURST ? PING_BURST_GAP_MS : (this.options.pingIntervalMs ?? 2_000);
      this.pingTimer = setTimeout(tick, delay);
    };
    tick();
  }

  private stopPinging(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private handleClose(code: number): void {
    this.socket = null;
    this.stopPinging();
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
    const sync = this.sync;
    this.snapshot = {
      status: this.status,
      song: sync ? viewSong(sync) : null,
      audible: sync ? sync.audible : null,
      queue: sync
        ? sync.scheduled.filter((entry) => entry.epoch === this.transport.epoch).map(({ row, op }) => ({ row, op }))
        : [],
      me: this.me,
      peers: [...this.peers.values()],
      transport: this.transport,
      clock: this.clockStatus(),
    };
    for (const listener of this.listeners) listener();
  }

  private clockStatus(): ClockStatus | null {
    const best = this.clock.best;
    if (!best) return null;
    return { offset: best.offset, rtt: best.rtt, lastRtt: this.clock.lastRtt, samples: this.clock.count };
  }
}
