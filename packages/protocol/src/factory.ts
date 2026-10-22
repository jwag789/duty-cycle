import { CHANNELS } from './constants';
import type { Cell, ChannelSettings, Song } from './song';

export const EMPTY_CELL: Readonly<Cell> = Object.freeze({ note: null, volume: null });

const DEFAULT_CHANNEL: ChannelSettings = { duty: 2, decay: 0, shortNoise: false };

export function emptySong(options: { bpm?: number; rows?: number; rowsPerBeat?: number } = {}): Song {
  const rows = options.rows ?? 32;
  return {
    bpm: options.bpm ?? 120,
    rowsPerBeat: options.rowsPerBeat ?? 4,
    rows,
    channels: CHANNELS.map(() => ({ ...DEFAULT_CHANNEL })),
    cells: CHANNELS.map(() => Array.from({ length: rows }, () => ({ ...EMPTY_CELL }))),
  };
}
