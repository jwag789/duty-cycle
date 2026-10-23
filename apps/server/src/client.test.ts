import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RoomConnection, type SocketLike } from '@duty-cycle/client';
import { emptySong, MAX_PEERS, type Op } from '@duty-cycle/protocol';
import { startServer, type RunningServer } from './server';

let server: RunningServer;
const connections: RoomConnection[] = [];

beforeEach(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  await server.close();
});

function connect(name: string, options: { seed?: ReturnType<typeof emptySong>; sockets?: WebSocket[] } = {}) {
  const connection = new RoomConnection({
    url: `ws://127.0.0.1:${server.port}/ws`,
    room: 'jam4test',
    name,
    seed: options.seed,
    retryMs: 20,
    createSocket: (url) => {
      const socket = new WebSocket(url);
      options.sockets?.push(socket);
      return socket as unknown as SocketLike;
    },
  });
  connection.connect();
  connections.push(connection);
  return connection;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const live = (c: RoomConnection) => c.getSnapshot().status === 'live';
const settled = (...cs: RoomConnection[]) => cs.every((c) => live(c) && c.pendingCount === 0);

function randomOps(count: number, seed: number): Op[] {
  let x = seed;
  const rand = (n: number) => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % n;
  };
  return Array.from({ length: count }, (): Op =>
    rand(3) === 0
      ? { type: 'setVolume', channel: rand(2), row: rand(3), volume: rand(16) }
      : { type: 'setNote', channel: rand(2), row: rand(3), note: 40 + rand(40) },
  );
}

describe('RoomConnection against the real server', () => {
  it('two players editing the same cells at once end up with the same song', async () => {
    const a = connect('Ada', { seed: emptySong() });
    await waitFor(() => live(a), 'Ada to join');
    const b = connect('Ben');
    await waitFor(() => live(b) && a.getSnapshot().peers.length === 1, 'Ben to join');

    const opsA = randomOps(30, 1);
    const opsB = randomOps(30, 2);
    for (let i = 0; i < 30; i++) {
      a.dispatch([opsA[i]!]);
      b.dispatch([opsB[i]!]);
    }

    await waitFor(() => settled(a, b), 'both to settle');
    expect(a.getSnapshot().song).toEqual(b.getSnapshot().song);
  });

  it('keeps edits made while disconnected and sends them after reconnecting', async () => {
    const sockets: WebSocket[] = [];
    const a = connect('Ada', { seed: emptySong(), sockets });
    await waitFor(() => live(a), 'Ada to join');
    const b = connect('Ben');
    await waitFor(() => live(b), 'Ben to join');

    sockets[0]!.terminate();
    await waitFor(() => a.getSnapshot().status === 'reconnecting', 'Ada to notice the drop');
    a.dispatch([{ type: 'setNote', channel: 3, row: 9, note: 63 }]);
    // Shown locally straight away, even offline.
    expect(a.getSnapshot().song!.cells[3]![9]!.note).toBe(63);

    await waitFor(() => settled(a, b) && b.getSnapshot().song!.cells[3]![9]!.note === 63, 'the edit to reach Ben');
    expect(a.getSnapshot().song).toEqual(b.getSnapshot().song);
  });

  it('restores the room from a client if the server restarts', async () => {
    const a = connect('Ada', { seed: emptySong() });
    await waitFor(() => live(a), 'Ada to join');
    a.dispatch([{ type: 'setBpm', bpm: 173 }]);
    await waitFor(() => settled(a), 'the edit to settle');

    const { port } = server;
    await server.close();
    await waitFor(() => a.getSnapshot().status === 'reconnecting', 'Ada to notice the restart');
    server = await startServer({ port, host: '127.0.0.1' });

    await waitFor(() => live(a), 'Ada to reconnect');
    const b = connect('Ben');
    await waitFor(() => live(b), 'Ben to join');
    expect(b.getSnapshot().song!.bpm).toBe(173);
  });

  it('syncs clocks and shares the transport', async () => {
    const a = connect('Ada', { seed: emptySong() });
    await waitFor(() => live(a), 'Ada to join');
    const b = connect('Ben');
    await waitFor(() => (a.getSnapshot().clock?.samples ?? 0) >= 3 && (b.getSnapshot().clock?.samples ?? 0) >= 3, 'clock samples');

    // Same process: the server clock is timeOrigin + performance.now(), so the
    // true offset is exactly timeOrigin.
    const { clock } = a.getSnapshot();
    expect(clock!.rtt).toBeLessThan(50);
    expect(Math.abs(clock!.offset - performance.timeOrigin)).toBeLessThan(clock!.rtt / 2 + 1);

    b.play(0);
    await waitFor(() => a.getSnapshot().transport.playing && b.getSnapshot().transport.playing, 'both to start');
    expect(a.getSnapshot().transport).toEqual(b.getSnapshot().transport);
    // Row 0 is in the future for both: the server left a lead.
    expect(a.getSnapshot().transport.anchorTime).toBeGreaterThan(a.serverNow());

    a.stop();
    await waitFor(() => !b.getSnapshot().transport.playing, 'both to stop');
  });

  it('shows peers and their cursors', async () => {
    const a = connect('Ada', { seed: emptySong() });
    await waitFor(() => live(a), 'Ada to join');
    const b = connect('Ben');
    await waitFor(() => live(b), 'Ben to join');

    b.setCursor({ row: 5, channel: 1, column: 'note' });
    await waitFor(() => a.getSnapshot().peers[0]?.cursor?.row === 5, "Ben's cursor");
    expect(a.getSnapshot().peers[0]).toMatchObject({ name: 'Ben', cursor: { row: 5, channel: 1, column: 'note' } });

    b.close();
    await waitFor(() => a.getSnapshot().peers.length === 0, 'Ben to leave');
  });

  it('reports a full room and stops retrying', async () => {
    for (let i = 0; i < MAX_PEERS; i++) {
      const c = connect(`P${i}`, { seed: emptySong() });
      await waitFor(() => live(c), `P${i} to join`);
    }
    const late = connect('Late');
    await waitFor(() => late.getSnapshot().status === 'full', 'the full status');
  });
});
