import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyOp, type Op } from './ops';
import { emptySong } from './factory';
import { applyLocal, applyRemote, createSync, viewSong, type SyncState } from './sync';
import type { OpMessage, ServerOpMessage } from './wire';

const CLIENTS = 3;

// A tiny grid so the clients keep colliding on the same cells.
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    type: fc.constant('setNote' as const),
    channel: fc.integer({ min: 0, max: 1 }),
    row: fc.integer({ min: 0, max: 2 }),
    note: fc.option(fc.integer({ min: 0, max: 127 }), { nil: null }),
  }),
  fc.record({
    type: fc.constant('setVolume' as const),
    channel: fc.integer({ min: 0, max: 1 }),
    row: fc.integer({ min: 0, max: 2 }),
    volume: fc.option(fc.integer({ min: 0, max: 15 }), { nil: null }),
  }),
  fc.record({ type: fc.constant('setBpm' as const), bpm: fc.integer({ min: 60, max: 200 }) }),
);

type Step =
  | { kind: 'edit'; client: number; op: Op }
  | { kind: 'serverReceives'; client: number }
  | { kind: 'clientReceives'; client: number };

const client = fc.integer({ min: 0, max: CLIENTS - 1 });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('edit' as const), client, op: opArb }),
  fc.record({ kind: fc.constant('serverReceives' as const), client }),
  fc.record({ kind: fc.constant('clientReceives' as const), client }),
);

/**
 * A server and CLIENTS clients joined by in-order queues (like WebSockets),
 * with the steps deciding who edits and which queue moves next.
 */
function simulate(steps: Step[]) {
  const start = emptySong({ rows: 4 });
  const server = { song: start, seq: 0 };
  const clients = Array.from({ length: CLIENTS }, (_, i) => ({
    id: `c${i}`,
    sync: createSync(start, 0) as SyncState,
    toServer: [] as OpMessage[],
    fromServer: [] as ServerOpMessage[],
  }));

  const serverReceives = (index: number) => {
    const sender = clients[index]!;
    const message = sender.toServer.shift();
    if (!message) return;
    server.song = applyOp(server.song, message.op);
    server.seq++;
    const broadcast: ServerOpMessage = { type: 'op', seq: server.seq, op: message.op, from: sender.id, clientSeq: message.clientSeq };
    for (const c of clients) c.fromServer.push(broadcast);
  };

  const clientReceives = (index: number) => {
    const c = clients[index]!;
    const message = c.fromServer.shift();
    if (!message) return;
    const next = applyRemote(c.sync, message, c.id);
    if (!next) throw new Error(`client ${c.id} saw a gap at seq ${message.seq}`);
    c.sync = next;
  };

  for (const step of steps) {
    if (step.kind === 'edit') {
      const c = clients[step.client]!;
      const { state, message } = applyLocal(c.sync, step.op);
      c.sync = state;
      c.toServer.push(message);
      // The editor sees its own edit immediately.
      expect(viewSong(c.sync)).toEqual(applyOp(viewSong({ ...c.sync, pending: c.sync.pending.slice(0, -1) }), step.op));
    } else if (step.kind === 'serverReceives') serverReceives(step.client);
    else clientReceives(step.client);
  }

  // Let the network drain.
  for (let i = 0; i < CLIENTS; i++) while (clients[i]!.toServer.length) serverReceives(i);
  for (let i = 0; i < CLIENTS; i++) while (clients[i]!.fromServer.length) clientReceives(i);

  return { server, clients };
}

describe('sync', () => {
  it('every client converges to the server song, whatever the interleaving', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 80 }), (steps) => {
        const { server, clients } = simulate(steps);
        for (const c of clients) {
          expect(c.sync.pending).toEqual([]);
          expect(c.sync.seq).toBe(server.seq);
          expect(viewSong(c.sync)).toEqual(server.song);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a local edit wins on screen until a later remote edit to the same cell arrives', () => {
    const me = 'me';
    let sync = createSync(emptySong(), 0);
    sync = applyLocal(sync, { type: 'setNote', channel: 0, row: 0, note: 60 }).state;

    // Someone else's edit to the same cell was ordered first: mine is still on top.
    sync = applyRemote(sync, { type: 'op', seq: 1, op: { type: 'setNote', channel: 0, row: 0, note: 72 }, from: 'them', clientSeq: 0 }, me)!;
    expect(viewSong(sync).cells[0]![0]!.note).toBe(60);

    // Mine comes back second, so it is the final value.
    sync = applyRemote(sync, { type: 'op', seq: 2, op: { type: 'setNote', channel: 0, row: 0, note: 60 }, from: me, clientSeq: 0 }, me)!;
    expect(sync.pending).toEqual([]);
    expect(viewSong(sync).cells[0]![0]!.note).toBe(60);
  });

  it('reports a gap in the sequence', () => {
    const sync = createSync(emptySong(), 4);
    expect(applyRemote(sync, { type: 'op', seq: 6, op: { type: 'setBpm', bpm: 90 }, from: 'x', clientSeq: 0 }, 'me')).toBeNull();
  });
});
