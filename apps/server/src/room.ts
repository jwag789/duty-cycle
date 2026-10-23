import {
  applyOp,
  leadTimeMs,
  MAX_PEERS,
  retempo,
  startTransport,
  STOPPED,
  stopTransport,
  type Cursor,
  type Op,
  type Peer,
  type ServerMessage,
  type Song,
  type Transport,
} from '@duty-cycle/protocol';

/** Cursor colours, chosen to stand apart from the four channel colours. */
const COLORS = ['#ff8a3d', '#c792ff', '#4fe0b6', '#ffe14d', '#ff5c6c', '#6aa8ff', '#f2f2f2', '#c6f36b'];

export interface RoomClient {
  readonly id: string;
  send(message: ServerMessage): void;
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
 */
export class Room {
  private song: Song;
  private seq = 0;
  private transport: Transport;
  private readonly members = new Map<string, Member>();

  constructor(
    readonly id: string,
    song: Song,
    private readonly now: () => number,
  ) {
    this.song = song;
    this.transport = { ...STOPPED, bpm: song.bpm, rowsPerBeat: song.rowsPerBeat };
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

    client.send({
      type: 'welcome',
      you: peer,
      seq: this.seq,
      song: this.song,
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
    if (this.members.size === 0) this.transport = stopTransport(this.transport);
  }

  applyClientOp(id: string, clientSeq: number, op: Op): void {
    if (!this.members.has(id)) return;
    this.song = applyOp(this.song, op);
    this.seq++;
    this.broadcast({ type: 'op', seq: this.seq, op, from: id, clientSeq });

    // A tempo change during playback lands on a row far enough ahead that
    // everyone switches on the same row.
    const next = retempo(this.transport, this.song, this.now() + this.lead());
    if (next !== this.transport) {
      this.transport = next;
      if (next.playing) this.broadcast({ type: 'transport', transport: next, by: id });
    }
  }

  play(id: string, fromRow = 0): void {
    if (!this.members.has(id)) return;
    this.transport = startTransport(this.song, fromRow, this.now() + this.lead());
    this.broadcast({ type: 'transport', transport: this.transport, by: id });
  }

  stop(id: string): void {
    if (!this.members.has(id) || !this.transport.playing) return;
    this.transport = stopTransport(this.transport);
    this.broadcast({ type: 'transport', transport: this.transport, by: id });
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
