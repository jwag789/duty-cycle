import {
  applyRemote,
  confirmedSong,
  createSync,
  leadTimeMs,
  MAX_PEERS,
  retempo,
  rowAt,
  rowStartingAfter,
  settle,
  startTransport,
  STOPPED,
  stopTransport,
  timeOfRow,
  type Cursor,
  type HistoryEvent,
  type Landing,
  type Op,
  type Peer,
  type ServerMessage,
  type ServerOpMessage,
  type Song,
  type SyncState,
  type Transport,
} from '@duty-cycle/protocol';

/** Cursor colours, chosen to stand apart from the four channel colours. */
const COLORS = ['#ff8a3d', '#c792ff', '#4fe0b6', '#ffe14d', '#ff5c6c', '#6aa8ff', '#f2f2f2', '#c6f36b'];

export interface RoomClient {
  readonly id: string;
  send(message: ServerMessage): void;
}

export interface RoomOptions {
  /** The server clock, in ms. */
  now: () => number;
  /** Ops already applied to the song, when restoring a saved room. */
  seq?: number;
  /** The transport to start from (stopped). Restored rooms keep counting epochs. */
  transport?: Transport;
  /** Called with every op and transport change, in order, for the event log. */
  onEvent?: (event: HistoryEvent) => void;
}

interface Member {
  client: RoomClient;
  peer: Peer;
  /** The member's best round trip to us, as they last reported it. */
  rtt: number | null;
}

/**
 * One jam. Holds the song and the single order of every edit to it: each op
 * gets the next sequence number and goes to everyone, its author included.
 * Also owns the transport, so there is exactly one answer to "which row is
 * playing at server time T".
 *
 * During playback each edit is stamped with the row it lands on, at least one
 * lead time ahead, so every player has it before that row plays. The room
 * keeps the same three-layer sync state as a client (with nothing pending),
 * so it can hand a newcomer exactly what's audible and what's still due.
 */
export class Room {
  private state: SyncState;
  private transport: Transport;
  /** Landing rows never go backwards, even if the lead shrinks: order is row order. */
  private lastLanding = 0;
  private readonly members = new Map<string, Member>();

  private readonly now: () => number;
  private readonly onEvent: (event: HistoryEvent) => void;

  constructor(
    readonly id: string,
    song: Song,
    options: RoomOptions,
  ) {
    this.now = options.now;
    this.onEvent = options.onEvent ?? (() => {});
    this.state = createSync(song, options.seq ?? 0);
    this.transport = { ...(options.transport ?? STOPPED), playing: false, bpm: song.bpm, rowsPerBeat: song.rowsPerBeat };
  }

  /** The server's whole song and how many ops built it, for snapshots. */
  snapshot(): { song: Song; seq: number } {
    return { song: confirmedSong(this.state), seq: this.state.seq };
  }

  get size(): number {
    return this.members.size;
  }

  isFull(): boolean {
    return this.members.size >= MAX_PEERS;
  }

  join(client: RoomClient, name: string): Peer {
    const used = new Set([...this.members.values()].map((member) => member.peer.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[this.members.size % COLORS.length]!;
    const peer: Peer = { id: client.id, name, color, cursor: null };

    this.settle();
    client.send({
      type: 'welcome',
      you: peer,
      seq: this.state.seq,
      song: this.state.audible,
      scheduled: [...this.state.scheduled],
      peers: [...this.members.values()].map((member) => member.peer),
      transport: this.transport,
    });
    this.broadcast({ type: 'joined', peer }, client.id);
    this.members.set(client.id, { client, peer, rtt: null });
    return peer;
  }

  leave(id: string): void {
    if (!this.members.delete(id)) return;
    this.broadcast({ type: 'left', id });
    // Nobody left to hear it: don't let the loop run on in an empty room.
    if (this.members.size === 0 && this.transport.playing) {
      this.stopAndSettle();
      this.record({ kind: 'transport', time: this.now(), transport: this.transport, by: null });
    }
  }

  applyClientOp(id: string, clientSeq: number, op: Op): void {
    if (!this.members.has(id)) return;
    this.settle();

    let at: Landing | null = null;
    if (this.transport.playing) {
      const row = Math.max(this.lastLanding, rowStartingAfter(this.transport, this.now() + this.lead()));
      this.lastLanding = row;
      at = { epoch: this.transport.epoch, row };
    }
    const message: ServerOpMessage = { type: 'op', seq: this.state.seq + 1, op, from: id, clientSeq, at };
    this.state = applyRemote(this.state, message, '')!;
    this.broadcast(message);
    this.record({ kind: 'op', time: this.now(), seq: message.seq, op, at, by: this.nameOf(id) });

    // A tempo change lands on the same row as the edit that made it, so the
    // BPM everyone sees and the tempo everyone hears switch together.
    const switchAt = at ? timeOfRow(this.transport, at.row) : this.now();
    const next = retempo(this.transport, confirmedSong(this.state), switchAt);
    if (next !== this.transport) {
      this.transport = next;
      if (next.playing) {
        this.broadcast({ type: 'transport', transport: next, by: id });
        this.record({ kind: 'transport', time: this.now(), transport: next, by: this.nameOf(id) });
      }
    }
  }

  play(id: string, fromRow = 0): void {
    if (!this.members.has(id)) return;
    // Edits waiting on the old epoch's rows land now; the new epoch counts from scratch.
    this.state = settle(this.state, stopTransport(this.transport), null);
    this.lastLanding = 0;
    this.transport = startTransport(this.transport, this.state.audible, fromRow, this.now() + this.lead());
    this.broadcast({ type: 'transport', transport: this.transport, by: id });
    this.record({ kind: 'transport', time: this.now(), transport: this.transport, by: this.nameOf(id) });
  }

  stop(id: string): void {
    if (!this.members.has(id) || !this.transport.playing) return;
    this.stopAndSettle();
    this.broadcast({ type: 'transport', transport: this.transport, by: id });
    this.record({ kind: 'transport', time: this.now(), transport: this.transport, by: this.nameOf(id) });
  }

  noteRoundTrip(id: string, rtt: number | null): void {
    const member = this.members.get(id);
    if (member) member.rtt = rtt;
  }

  moveCursor(id: string, cursor: Cursor): void {
    const member = this.members.get(id);
    if (!member) return;
    member.peer = { ...member.peer, cursor };
    this.broadcast({ type: 'cursor', id, cursor }, id);
  }

  private record(event: HistoryEvent): void {
    this.onEvent(event);
  }

  private nameOf(id: string): string {
    return this.members.get(id)?.peer.name ?? 'someone';
  }

  private stopAndSettle(): void {
    this.transport = stopTransport(this.transport);
    this.state = settle(this.state, this.transport, null);
  }

  /** Moves edits whose row has started into the audible song. */
  private settle(): void {
    const row = this.transport.playing ? Math.floor(rowAt(this.transport, this.now())) : null;
    this.state = settle(this.state, this.transport, row);
  }

  /** How far ahead to schedule, from the slowest member's round trip. */
  private lead(): number {
    return leadTimeMs([...this.members.values()].map((member) => member.rtt));
  }

  private broadcast(message: ServerMessage, except?: string): void {
    for (const [id, member] of this.members) {
      if (id !== except) member.client.send(message);
    }
  }
}
