import { z } from 'zod';
import { OpSchema } from './ops';
import { SongSchema } from './song';
import { applyRemote, createSync, settle, viewSong, type SyncState } from './sync';
import { rowAt, STOPPED, type Transport } from './transport';
import { LandingSchema, TransportSchema } from './wire';

/**
 * Everything that happened in a room, in server order, stamped with server
 * time. Replaying it through the same sync code the players ran recreates
 * exactly what they heard and when.
 */
export const HistoryEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('op'),
    time: z.number().finite(),
    seq: z.number().int().positive(),
    op: OpSchema,
    at: LandingSchema.nullable(),
    /** The player's name, for display. */
    by: z.string(),
  }),
  z.object({
    kind: z.literal('transport'),
    time: z.number().finite(),
    transport: TransportSchema,
    by: z.string().nullable(),
  }),
]);

export const HistorySchema = z.object({
  room: z.string(),
  seed: SongSchema,
  events: z.array(HistoryEventSchema),
});

export type HistoryEvent = z.infer<typeof HistoryEventSchema>;
export type History = z.infer<typeof HistorySchema>;

export function parseHistory(data: unknown): History | null {
  const result = HistorySchema.safeParse(data);
  return result.success ? result.data : null;
}

/** A replay in progress: the sync state after `next` events. */
export interface ReplayCursor {
  readonly sync: SyncState;
  readonly transport: Transport;
  /** Index of the next event to apply. */
  readonly next: number;
}

export function replayStart(history: History): ReplayCursor {
  return { sync: createSync(history.seed, 0), transport: STOPPED, next: 0 };
}

/**
 * Applies every event up to and including `time`. Moving backwards starts
 * over from the seed, so seeking anywhere is just a call to this.
 */
export function replayTo(history: History, cursor: ReplayCursor, time: number): ReplayCursor {
  if (cursor.next > 0 && history.events[cursor.next - 1]!.time > time) cursor = replayStart(history);
  let { sync, transport, next } = cursor;
  while (next < history.events.length && history.events[next]!.time <= time) {
    const event = history.events[next]!;
    if (event.kind === 'op') {
      // Numbered from the replay's own count, so a gap in the log can't stall it.
      sync = applyRemote(sync, { type: 'op', seq: sync.seq + 1, op: event.op, from: '', clientSeq: 0, at: event.at }, 'replay')!;
    } else {
      transport = event.transport;
      sync = settle(sync, transport, null);
    }
    next++;
  }
  return { sync, transport, next };
}

/**
 * What a player would have had at `time`: the song on screen, what was
 * audible, and the edits still queued for later rows.
 */
export function replayFrame(cursor: ReplayCursor, time: number) {
  const { transport } = cursor;
  const row = transport.playing ? Math.floor(rowAt(transport, time)) : null;
  const sync = settle(cursor.sync, transport, row);
  return {
    song: viewSong(sync),
    audible: sync.audible,
    queue: sync.scheduled.filter((entry) => entry.epoch === transport.epoch).map(({ row, op }) => ({ row, op })),
    transport,
  };
}

/** The span worth replaying: first event to a little after the last. */
export function historySpan(history: History, tailMs = 3_000): { start: number; end: number } | null {
  const first = history.events[0];
  const last = history.events.at(-1);
  if (!first || !last) return null;
  return { start: first.time, end: last.time + tailMs };
}


