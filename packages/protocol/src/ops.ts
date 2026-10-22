import { z } from 'zod';
import { CHANNELS, MAX_ROWS } from './constants';
import { EMPTY_CELL } from './factory';
import { BpmSchema, CellSchema, ChannelSettingsSchema, SongSchema, type Cell, type ChannelSettings, type Song } from './song';

const ChannelIndex = z.number().int().min(0).max(CHANNELS.length - 1);
const RowIndex = z.number().int().min(0).max(MAX_ROWS - 1);

/**
 * Every change to a song is one of these. They cross the wire, the server puts
 * them in one order, and every client applies them with the same applyOp.
 * Each op sets a value rather than adjusting one, so applying an op twice is
 * harmless. That keeps resending after a reconnect safe.
 */
export const OpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setNote'), channel: ChannelIndex, row: RowIndex, note: CellSchema.shape.note }),
  z.object({ type: z.literal('setVolume'), channel: ChannelIndex, row: RowIndex, volume: CellSchema.shape.volume }),
  z.object({ type: z.literal('clearCell'), channel: ChannelIndex, row: RowIndex }),
  z.object({ type: z.literal('setBpm'), bpm: BpmSchema }),
  z.object({ type: z.literal('setChannel'), channel: ChannelIndex, settings: ChannelSettingsSchema.partial() }),
  /** Load demo, Clear: swaps the whole song. */
  z.object({ type: z.literal('replaceSong'), song: SongSchema }),
]);

export type Op = z.infer<typeof OpSchema>;

export function parseOp(data: unknown): Op | null {
  const result = OpSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Applies one op and returns a new song, sharing every untouched column.
 * Ops that point outside the song are ignored rather than thrown, because a
 * remote op can legitimately race a change to the song's size.
 */
export function applyOp(song: Song, op: Op): Song {
  switch (op.type) {
    case 'setNote':
      return updateCell(song, op.channel, op.row, { note: op.note });
    case 'setVolume':
      return updateCell(song, op.channel, op.row, { volume: op.volume });
    case 'clearCell':
      return updateCell(song, op.channel, op.row, EMPTY_CELL);
    case 'setBpm':
      return song.bpm === op.bpm ? song : { ...song, bpm: op.bpm };
    case 'setChannel': {
      const current = song.channels[op.channel];
      if (!current) return song;
      const patch = definedOnly(op.settings);
      const channels = song.channels.slice();
      channels[op.channel] = { ...current, ...patch };
      return { ...song, channels };
    }
    case 'replaceSong':
      return op.song;
  }
}

function updateCell(song: Song, channel: number, row: number, patch: Partial<Cell>): Song {
  const column = song.cells[channel];
  const cell = column?.[row];
  if (!column || !cell) return song;
  const nextColumn = column.slice();
  nextColumn[row] = { ...cell, ...patch };
  const cells = song.cells.slice();
  cells[channel] = nextColumn;
  return { ...song, cells };
}

function definedOnly(settings: Partial<ChannelSettings>): Partial<ChannelSettings> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}
