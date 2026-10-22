import { z } from 'zod';
import { CHANNELS, DUTY_CYCLES, MAX_DECAY, MAX_NOTE, MAX_ROWS, MAX_BPM, MAX_VOLUME, MIN_BPM, NOTE_OFF } from './constants';

export const CellSchema = z.object({
  /** MIDI note number, NOTE_OFF to release, or null to leave the channel alone. */
  note: z.number().int().min(NOTE_OFF).max(MAX_NOTE).nullable(),
  /** 0–15, or null to keep the note's default (full) level. */
  volume: z.number().int().min(0).max(MAX_VOLUME).nullable(),
});

export const ChannelSettingsSchema = z.object({
  /** Index into DUTY_CYCLES. Pulse channels only. */
  duty: z.number().int().min(0).max(DUTY_CYCLES.length - 1),
  /** How fast a held note fades: 0 sustains, 15 drops a full-volume note to silence in 125 ms. */
  decay: z.number().int().min(0).max(MAX_DECAY),
  /** Noise only: the short, metallic 93-step LFSR mode. */
  shortNoise: z.boolean(),
});

export const BpmSchema = z.number().int().min(MIN_BPM).max(MAX_BPM);

export const SongSchema = z
  .object({
    bpm: BpmSchema,
    rowsPerBeat: z.number().int().min(1).max(8),
    rows: z.number().int().min(1).max(MAX_ROWS),
    channels: z.array(ChannelSettingsSchema).length(CHANNELS.length),
    /** cells[channel][row] */
    cells: z.array(z.array(CellSchema)).length(CHANNELS.length),
  })
  .refine((song) => song.cells.every((column) => column.length === song.rows), {
    message: 'Every channel needs exactly one cell per row',
  });

export type Cell = z.infer<typeof CellSchema>;
export type ChannelSettings = z.infer<typeof ChannelSettingsSchema>;
export type Song = z.infer<typeof SongSchema>;

/** Validates untrusted data (storage, the network) as a Song. */
export function parseSong(data: unknown): Song | null {
  const result = SongSchema.safeParse(data);
  return result.success ? result.data : null;
}
