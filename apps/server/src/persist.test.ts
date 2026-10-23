import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  applyOp,
  emptySong,
  parseHistory,
  parseServerMessage,
  type ClientMessage,
  type HistoryEvent,
  type Op,
  type ServerMessage,
} from '@duty-cycle/protocol';
import { startServer, type RunningServer } from './server';
import { openPglite, RoomStore, SNAPSHOT_EVERY } from './store';

let store: RoomStore;
let clock = 1_000_000;

beforeEach(async () => {
  clock = 1_000_000;
  store = await RoomStore.open(await openPglite()); // Postgres, in memory
});

afterEach(async () => {
  await store.close();
});

const setNote = (row: number, note: number): Op => ({ type: 'setNote', channel: 1, row, note });
const opEvent = (seq: number, op: Op): HistoryEvent => ({ kind: 'op', time: seq, seq, op, at: null, by: 'Ada' });

describe('RoomStore', () => {
  it('rebuilds a room from its seed and log', async () => {
    const seed = emptySong({ bpm: 99 });
    await store.createRoom('room123', seed);
    await store.appendEvent('room123', opEvent(1, setNote(0, 60)));
    await store.appendEvent('room123', opEvent(2, setNote(1, 62)));

    const loaded = await store.loadRoom('room123');
    expect(loaded!.seq).toBe(2);
    expect(loaded!.song).toEqual(applyOp(applyOp(seed, setNote(0, 60)), setNote(1, 62)));
    expect(await store.loadRoom('nosuchroom')).toBeNull();
  });

  it('loads from the latest snapshot plus the ops after it', async () => {
    let song = emptySong();
    await store.createRoom('room123', song);
    for (let seq = 1; seq <= SNAPSHOT_EVERY + 5; seq++) {
      const op = setNote(seq % 32, 40 + (seq % 40));
      song = applyOp(song, op);
      await store.appendEvent('room123', opEvent(seq, op));
      if (seq === SNAPSHOT_EVERY) await store.saveSnapshot('room123', seq, song);
    }
    const loaded = await store.loadRoom('room123');
    expect(loaded!.seq).toBe(SNAPSHOT_EVERY + 5);
    expect(loaded!.song).toEqual(song);
  });

  it('refuses two ops with the same place in a room', async () => {
    await store.createRoom('room123', emptySong());
    await store.appendEvent('room123', opEvent(1, setNote(0, 60)));
    await expect(store.appendEvent('room123', opEvent(1, setNote(0, 61)))).rejects.toThrow();
  });

  it('returns the history in order, as valid history', async () => {
    await store.createRoom('room123', emptySong());
    await store.appendEvent('room123', opEvent(1, setNote(0, 60)));
    await store.appendEvent('room123', {
      kind: 'transport',
      time: 5,
      transport: { playing: true, epoch: 1, anchorTime: 300, anchorRow: 0, bpm: 120, rowsPerBeat: 4 },
      by: 'Ada',
    });
    await store.appendEvent('room123', opEvent(2, setNote(1, 62)));
    const history = parseHistory(await store.history('room123'));
    expect(history!.events.map((e) => e.kind)).toEqual(['op', 'transport', 'op']);
  });
});

/** A bare WebSocket client that remembers what it got. */
async function join(server: RunningServer, room: string, name: string, seed?: ReturnType<typeof emptySong>) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: ServerMessage[] = [];
  const waiters: [string, (m: ServerMessage) => void][] = [];
  socket.on('message', (data) => {
    const message = parseServerMessage(data.toString())!;
    received.push(message);
    const i = waiters.findIndex(([type]) => type === message.type);
    if (i >= 0) waiters.splice(i, 1)[0]![1](message);
  });
  const next = <T extends ServerMessage['type']>(type: T) =>
    new Promise<Extract<ServerMessage, { type: T }>>((resolve) => waiters.push([type, resolve as (m: ServerMessage) => void]));
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  await new Promise((resolve) => socket.once('open', resolve));
  const welcome = next('welcome');
  send({ type: 'hello', room, name, ...(seed ? { seed } : {}) });
  return { socket, received, next, send, welcome: await welcome };
}

describe('rooms that outlive the server', () => {
  let server: RunningServer;
  const start = async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', now: () => clock, store });
  };

  beforeEach(start);
  afterEach(async () => {
    await server.close();
  });

  it('come back after a restart with their song, order and epochs intact', async () => {
    const seed = emptySong({ bpm: 128 });
    const a = await join(server, 'keepme', 'Ada', seed);
    a.send({ type: 'op', clientSeq: 0, op: setNote(0, 60) });
    await a.next('op');
    a.send({ type: 'transport', action: 'play' });
    expect((await a.next('transport')).transport.epoch).toBe(1);
    clock += 2_000;
    a.send({ type: 'op', clientSeq: 1, op: setNote(1, 62) }); // scheduled: playing
    const scheduled = await a.next('op');
    expect(scheduled.at).not.toBeNull();

    // The server goes down mid-song.
    await server.close();
    await start();

    const b = await join(server, 'keepme', 'Ben', emptySong({ bpm: 60 }));
    expect(b.welcome.seq).toBe(2);
    expect(b.welcome.song).toEqual(applyOp(applyOp(seed, setNote(0, 60)), setNote(1, 62)));
    expect(b.welcome.transport.playing).toBe(false); // nothing is playing after a restart

    // The order and the epochs carry on from where they were.
    b.send({ type: 'op', clientSeq: 0, op: setNote(2, 64) });
    expect((await b.next('op')).seq).toBe(3);
    b.send({ type: 'transport', action: 'play' });
    expect((await b.next('transport')).transport.epoch).toBe(2);

    // The log has it all, including that the music stopped when the server did.
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rooms/keepme/history`);
    const history = parseHistory(await response.json())!;
    expect(history.seed).toEqual(seed);
    expect(history.events.map((e) => (e.kind === 'op' ? `op${e.seq}` : e.transport.playing ? 'play' : 'stop'))).toEqual([
      'op1',
      'play',
      'op2',
      'stop',
      'op3',
      'play',
    ]);
    expect(history.events[0]).toMatchObject({ by: 'Ada' });
  });

  it('answers 404 for history of an unknown or malformed room', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/rooms/nosuchroom/history`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/rooms/..%2Fetc/history`)).status).toBe(404);
  });

  it('loads a room once even when two players arrive at the same moment', async () => {
    const [a, b] = await Promise.all([join(server, 'together', 'Ada'), join(server, 'together', 'Ben')]);
    // Whoever joined second sees the first: they're in the same room object.
    expect(a.welcome.peers.length + b.welcome.peers.length).toBe(1);
  });
});
