import { z } from 'zod';
import { CHANNELS, MAX_ROWS } from './constants';
import { BpmSchema, CellSchema, ChannelSettingsSchema, SongSchema } from './song';

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
