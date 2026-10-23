import { describe, expect, it } from 'vitest';
import { ChipSynth, Sequencer } from '@duty-cycle/engine/dsp';
import {
  applyLocal,
  applyRemote,
  createSync,
  demoSong,
  framesPerRow,
  settle,
  STOPPED,
  type Op,
  type ServerMessage,
  type SyncState,
  type Transport,
} from '@duty-cycle/protocol';
import { Room } from './room';

/**
 * M3's claim, end to end: players on different networks hear every edit start
 * on the same row, so their speakers put out identical samples.
 *
 * A real Room runs on a simulated network in 1 ms steps of true time (the
 * server's clock). Each player keeps the same sync state the browser does and
 * drives the real Sequencer and ChipSynth, feeding them exactly what the app
 * feeds the audio thread: the audible song plus queued edits, and the transport
 * mapped onto an audio clock. Clocks are perfect here; clock sync has its own
 * tests. This isolates the question: do edits land on the same row everywhere?
 */

const FRAMES_PER_MS = 48; // 48 kHz
const DURATION_MS = 9_000;

interface Network {
  /** One-way delays in ms, plus up to `jitter` ms extra per message. */
  up: number;
  down: number;
  jitter: number;
  /** The round trip this player tells the server it has. Honest unless a test says otherwise. */
  reportedRtt?: number;
}

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface Player {
  id: string;
  net: Network;
  inbox: { at: number; message: ServerMessage }[];
  lastDelivery: number;
  sync: SyncState | null;
  transport: Transport;
  sequencer: Sequencer;
  samples: Float32Array;
  /** Edits whose row was already playing when the message arrived. */
  lateEdits: number;
}

function simulate(networks: Network[], seed: number) {
  const random = rng(seed);
  let now = 0;
  const room = new Room('beattest', demoSong(), () => now);
  const toServer: { at: number; run: () => void }[] = [];
  const lastUp = new Map<string, number>();

  const players: Player[] = networks.map((net, i) => {
    const song = demoSong();
    return {
      id: `p${i}`,
      net,
      inbox: [],
      lastDelivery: 0,
      sync: null,
      transport: STOPPED,
      sequencer: new Sequencer(new ChipSynth(FRAMES_PER_MS * 1000, song.channels), song),
      samples: new Float32Array(DURATION_MS * FRAMES_PER_MS),
      lateEdits: 0,
    };
  });

  // Messages on one link arrive in order (it's a WebSocket), each delayed by base + jitter.
  const deliverDown = (player: Player, message: ServerMessage) => {
    const at = Math.max(player.lastDelivery, now + player.net.down + random() * player.net.jitter);
    player.lastDelivery = at;
    player.inbox.push({ at, message });
  };
  const sendUp = (player: Player, run: () => void) => {
    const at = Math.max(lastUp.get(player.id) ?? 0, now + player.net.up + random() * player.net.jitter);
    lastUp.set(player.id, at);
    toServer.push({ at, run });
  };

  for (const player of players) {
    room.join({ id: player.id, send: (message) => deliverDown(player, message) }, player.id);
    room.noteRoundTrip(player.id, player.net.reportedRtt ?? player.net.up + player.net.down + player.net.jitter);
  }

  // What each player does, and when (true time, ms).
  const script: { at: number; player: number; op: Op | 'play' }[] = [{ at: 200, player: 0, op: 'play' }];
  for (let i = 0; i < 40; i++) {
    script.push({
      at: 1_000 + Math.floor(random() * 7_000),
      player: i % players.length,
      op: { type: 'setNote', channel: Math.floor(random() * 4), row: Math.floor(random() * 32), note: 48 + Math.floor(random() * 24) },
    });
  }
  script.push({ at: 4_000, player: 1 % players.length, op: { type: 'setBpm', bpm: 168 } });
  script.push({ at: 6_000, player: 0, op: { type: 'setChannel', channel: 0, settings: { duty: 3 } } });
  script.sort((a, b) => a.at - b.at);

  const pushToAudio = (player: Player) => {
    if (!player.sync) return;
    const queue = player.sync.scheduled
      .filter((entry) => entry.epoch === player.transport.epoch)
      .map(({ row, op }) => ({ row, op }));
    player.sequencer.setSong(player.sync.audible, queue);
  };

  for (now = 0; now < DURATION_MS; now++) {
    // The server handles whatever has arrived.
    for (const item of toServer.filter((m) => m.at <= now)) item.run();
    toServer.splice(0, toServer.length, ...toServer.filter((m) => m.at > now));

    // Players act on their script.
    while (script.length > 0 && script[0]!.at <= now) {
      const { player: index, op } = script.shift()!;
      const player = players[index]!;
      if (op === 'play') {
        sendUp(player, () => room.play(player.id));
      } else if (player.sync) {
        const { state, message } = applyLocal(player.sync, op);
        player.sync = state;
        sendUp(player, () => room.applyClientOp(player.id, message.clientSeq, message.op));
      }
    }

    for (const player of players) {
      const frame = now * FRAMES_PER_MS;

      // Deliveries due by now.
      while (player.inbox.length > 0 && player.inbox[0]!.at <= now) {
        const { message } = player.inbox.shift()!;
        if (message.type === 'welcome') {
          player.sync = createSync(message.song, message.seq, message.scheduled);
          player.transport = message.transport;
        } else if (message.type === 'op' && player.sync) {
          if (message.at && player.transport.epoch === message.at.epoch && player.transport.playing) {
            const rowStart = player.transport.anchorTime + (message.at.row - player.transport.anchorRow) * (60_000 / (player.transport.bpm * player.transport.rowsPerBeat));
            if (rowStart <= now) player.lateEdits++;
          }
          player.sync = applyRemote(player.sync, message, player.id)!;
        } else if (message.type === 'transport') {
          player.transport = message.transport;
          const t = message.transport;
          player.sequencer.setTiming(
            t.playing
              ? {
                  anchorFrame: t.anchorTime * FRAMES_PER_MS,
                  anchorRow: t.anchorRow,
                  framesPerRow: framesPerRow(FRAMES_PER_MS * 1000, t.bpm, t.rowsPerBeat),
                }
              : null,
            frame,
          );
        }
        // A stop or a new epoch lands everything; otherwise edits wait in the audio queue.
        if (player.sync) player.sync = settle(player.sync, player.transport, null);
        pushToAudio(player);
      }

      for (let i = 0; i < FRAMES_PER_MS; i++) player.samples[frame + i] = player.sequencer.tick(frame + i);
    }
  }

  return players;
}

describe('edits land on the same beat for everyone', () => {
  it('two players on very different networks produce bit-identical audio', () => {
    const [near, far] = simulate(
      [
        { up: 8, down: 8, jitter: 10 }, // same city
        { up: 140, down: 160, jitter: 60 }, // other side of the world, on bad Wi-Fi
      ],
      7,
    );

    expect(near!.lateEdits).toBe(0);
    expect(far!.lateEdits).toBe(0);

    // The music actually changed: the edits and the tempo change were heard.
    const silentStart = near!.samples.slice(0, 200 * FRAMES_PER_MS);
    expect(silentStart.every((s) => s === 0)).toBe(true);
    expect(near!.samples.some((s) => s !== 0)).toBe(true);

    expect(far!.samples).toEqual(near!.samples);
  });

  it('holds across many random networks', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = rng(seed * 101);
      const nets = [0, 1, 2].map(() => ({ up: 5 + random() * 150, down: 5 + random() * 150, jitter: random() * 80 }));
      const [first, ...rest] = simulate(nets, seed);
      for (const other of rest) {
        expect(other.lateEdits).toBe(0);
        expect(other.samples).toEqual(first!.samples);
      }
    }
  }, 30_000); // Renders 9 s of 48 kHz audio for 15 players.

  it('fails when a player claims a faster network than it has (the test can tell)', () => {
    // Reports a 20 ms round trip but really takes 600 ms down: the lead is too short for it.
    const [honest, liar] = simulate(
      [
        { up: 8, down: 8, jitter: 10 },
        { up: 10, down: 600, jitter: 10, reportedRtt: 20 },
      ],
      7,
    );
    expect(honest!.lateEdits).toBe(0);
    expect(liar!.lateEdits).toBeGreaterThan(0);
    expect(liar!.samples).not.toEqual(honest!.samples);
  });
});
