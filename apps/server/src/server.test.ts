import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  CLOSE,
  emptySong,
  MAX_PEERS,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@duty-cycle/protocol';
import { startServer, type RunningServer } from './server';

let server: RunningServer;

beforeEach(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', rateLimit: { burst: 20, perSecond: 1 } });
});

afterEach(async () => {
  await server.close();
});

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** A test client that records every message and can wait for the next of a type. */
class TestClient {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly closed: Promise<number>;
  private waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];

  constructor() {
    this.socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => resolve(code)));
    this.socket.on('message', (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) throw new Error(`unparseable server message: ${data.toString()}`);
      this.received.push(message);
      const index = this.waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(message);
    });
  }

  async open(): Promise<this> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve) => this.socket.once('open', resolve));
    }
    return this;
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  next<T extends ServerMessage['type']>(type: T): Promise<Of<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Of<T>);
        },
      });
    });
  }

  of<T extends ServerMessage['type']>(type: T): Of<T>[] {
    return this.received.filter((m): m is Of<T> => m.type === type);
  }
}

async function join(room: string, name: string, seed?: ReturnType<typeof emptySong>) {
  const client = await new TestClient().open();
  const welcome = client.next('welcome');
  client.send({ type: 'hello', room, name, ...(seed ? { seed } : {}) });
  return { client, welcome: await welcome };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('rooms', () => {
  it('starts a new room from the seed song', async () => {
    const seed = emptySong({ bpm: 99 });
    const { welcome } = await join('room123', 'Ada', seed);
    expect(welcome.seq).toBe(0);
    expect(welcome.song).toEqual(seed);
    expect(welcome.peers).toEqual([]);
    expect(welcome.you).toMatchObject({ name: 'Ada', cursor: null });
  });

  it('ignores the seed when the room already exists', async () => {
    await join('room123', 'Ada', emptySong({ bpm: 99 }));
    const { welcome } = await join('room123', 'Ben', emptySong({ bpm: 180 }));
    expect(welcome.song.bpm).toBe(99);
    expect(welcome.peers.map((p) => p.name)).toEqual(['Ada']);
  });

  it('orders an op, echoes it to its author and sends it to everyone else', async () => {
    const a = await join('room123', 'Ada', emptySong());
    const b = await join('room123', 'Ben');

    const echo = a.client.next('op');
    const relayed = b.client.next('op');
    a.client.send({ type: 'op', clientSeq: 7, op: { type: 'setNote', channel: 0, row: 3, note: 64 } });

    const expected = { type: 'op', seq: 1, from: a.welcome.you.id, clientSeq: 7 };
    expect(await echo).toMatchObject(expected);
    expect(await relayed).toMatchObject(expected);

    // A late joiner gets the result in its snapshot, at the same sequence number.
    const c = await join('room123', 'Cy');
    expect(c.welcome.seq).toBe(1);
    expect(c.welcome.song.cells[0]![3]!.note).toBe(64);
  });

  it('rejects an invalid op without changing the song', async () => {
    const a = await join('room123', 'Ada', emptySong());
    const error = a.client.next('error');
    a.client.send({ type: 'op', clientSeq: 0, op: { type: 'setNote', channel: 9, row: 0, note: 60 } });
    expect((await error).message).toBe('Invalid message');

    const late = await join('room123', 'Ben');
    expect(late.welcome.seq).toBe(0);
  });

  it('tells others about joins, cursor moves and leaves, but not the mover', async () => {
    const a = await join('room123', 'Ada', emptySong());
    const joined = a.client.next('joined');
    const b = await join('room123', 'Ben');
    expect((await joined).peer.name).toBe('Ben');
    expect(b.welcome.you.color).not.toBe(a.welcome.you.color);

    const moved = a.client.next('cursor');
    b.client.send({ type: 'cursor', cursor: { row: 4, channel: 2, column: 'volume' } });
    expect(await moved).toEqual({ type: 'cursor', id: b.welcome.you.id, cursor: { row: 4, channel: 2, column: 'volume' } });
    await settle();
    expect(b.client.of('cursor')).toEqual([]);

    const left = a.client.next('left');
    b.client.socket.close();
    expect((await left).id).toBe(b.welcome.you.id);
  });

  it('turns away a player once the room is full', async () => {
    for (let i = 0; i < MAX_PEERS; i++) await join('room123', `P${i}`, emptySong());
    const extra = await new TestClient().open();
    extra.send({ type: 'hello', room: 'room123', name: 'Late' });
    expect(await extra.closed).toBe(CLOSE.roomFull);
  });
});

describe('connection rules', () => {
  it('closes a connection whose first message is not hello', async () => {
    const client = await new TestClient().open();
    client.send({ type: 'cursor', cursor: { row: 0, channel: 0, column: 'note' } });
    expect(await client.closed).toBe(CLOSE.badHello);
  });

  it('rejects room ids outside the allowed pattern', async () => {
    const client = await new TestClient().open();
    client.send({ type: 'hello', room: '../etc', name: 'Eve' });
    expect(await client.closed).toBe(CLOSE.badHello);
  });

  it('rate-limits a client that floods', async () => {
    const a = await join('room123', 'Ada', emptySong());
    for (let i = 0; i < 40; i++) a.client.send({ type: 'cursor', cursor: { row: 0, channel: 0, column: 'note' } });
    await settle();
    expect(a.client.of('error').some((e) => e.message.includes('slow down'))).toBe(true);
  });
});
