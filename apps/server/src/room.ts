import { applyOp, MAX_PEERS, type Cursor, type Op, type Peer, type ServerMessage, type Song } from '@duty-cycle/protocol';

/** Cursor colours, chosen to stand apart from the four channel colours. */
const COLORS = ['#ff8a3d', '#c792ff', '#4fe0b6', '#ffe14d', '#ff5c6c', '#6aa8ff', '#f2f2f2', '#c6f36b'];

export interface RoomClient {
  readonly id: string;
  send(message: ServerMessage): void;
}

/**
 * One jam. Holds the song and the single order of every edit to it: each op
 * gets the next sequence number and goes to everyone, its author included.
 */
export class Room {
  private song: Song;
  private seq = 0;
  private readonly members = new Map<string, { client: RoomClient; peer: Peer }>();

  constructor(
    readonly id: string,
    song: Song,
  ) {
    this.song = song;
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
    });
    this.broadcast({ type: 'joined', peer }, client.id);
    this.members.set(client.id, { client, peer });
    return peer;
  }

  leave(id: string): void {
    if (this.members.delete(id)) this.broadcast({ type: 'left', id });
  }

  applyClientOp(id: string, clientSeq: number, op: Op): void {
    if (!this.members.has(id)) return;
    this.song = applyOp(this.song, op);
    this.seq++;
    this.broadcast({ type: 'op', seq: this.seq, op, from: id, clientSeq });
  }

  moveCursor(id: string, cursor: Cursor): void {
    const member = this.members.get(id);
    if (!member) return;
    member.peer = { ...member.peer, cursor };
    this.broadcast({ type: 'cursor', id, cursor }, id);
  }

  private broadcast(message: ServerMessage, except?: string): void {
    for (const [id, member] of this.members) {
      if (id !== except) member.client.send(message);
    }
  }
}
