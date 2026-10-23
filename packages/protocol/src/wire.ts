import { z } from 'zod';
import { CHANNELS, MAX_ROWS } from './constants';
import { OpSchema } from './ops';
import { SongSchema } from './song';

export const ROOM_ID_PATTERN = /^[a-z0-9]{6,32}$/;
export const MAX_NAME_LENGTH = 24;
export const MAX_PEERS = 8;
/** Largest message either side will accept. A 256-row replaceSong is well under this. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** WebSocket close codes the client acts on. */
export const CLOSE = {
  /** The first message wasn't a valid hello. Don't retry. */
  badHello: 4000,
  /** The room already has MAX_PEERS players. Don't retry. */
  roomFull: 4001,
  /** The server is at its room limit. Retrying later may work. */
  serverFull: 4002,
} as const;

export const CursorSchema = z.object({
  row: z.number().int().min(0).max(MAX_ROWS - 1),
  channel: z.number().int().min(0).max(CHANNELS.length - 1),
  column: z.enum(['note', 'volume']),
});

export const TransportSchema = z.object({
  playing: z.boolean(),
  epoch: z.number().int().nonnegative(),
  anchorTime: z.number().finite(),
  anchorRow: z.number().int().nonnegative(),
  bpm: z.number().int().positive(),
  rowsPerBeat: z.number().int().positive(),
});

/** Where an edit takes effect: absolute row `row` of transport epoch `epoch`. */
export const LandingSchema = z.object({
  epoch: z.number().int().nonnegative(),
  row: z.number().int().nonnegative(),
});

export const ScheduledOpSchema = LandingSchema.extend({ op: OpSchema });

export const PeerSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  cursor: CursorSchema.nullable(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    room: z.string().regex(ROOM_ID_PATTERN),
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    /** The song to start a new room with. Ignored if the room already exists. */
    seed: SongSchema.optional(),
  }),
  /** clientSeq lets the sender recognise its own op when the server echoes it back. */
  z.object({ type: z.literal('op'), clientSeq: z.number().int().nonnegative(), op: OpSchema }),
  z.object({ type: z.literal('cursor'), cursor: CursorSchema }),
  /** Clock sync. `rtt` reports the sender's best round trip so far, which sets the room's lead time. */
  z.object({
    type: z.literal('ping'),
    id: z.number().int().nonnegative(),
    t0: z.number().finite(),
    rtt: z.number().finite().nonnegative().nullable(),
  }),
  /** Asks the server to start or stop playback for the whole room. */
  z.object({
    type: z.literal('transport'),
    action: z.enum(['play', 'stop']),
    fromRow: z.number().int().min(0).max(MAX_ROWS - 1).optional(),
  }),
]);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  /**
   * The first message on every connection: the room as it is right now.
   * `song` is what's audible; `scheduled` are ordered edits still waiting for their row.
   */
  z.object({
    type: z.literal('welcome'),
    you: PeerSchema,
    seq: z.number().int().nonnegative(),
    song: SongSchema,
    scheduled: z.array(ScheduledOpSchema),
    peers: z.array(PeerSchema),
    transport: TransportSchema,
  }),
  /** One op in the room's single order. Sent to everyone, including its author. */
  z.object({
    type: z.literal('op'),
    seq: z.number().int().positive(),
    op: OpSchema,
    from: z.string(),
    clientSeq: z.number().int().nonnegative(),
    /** The row it's heard from, during playback. Null when stopped: it applies at once. */
    at: LandingSchema.nullable(),
  }),
  z.object({ type: z.literal('joined'), peer: PeerSchema }),
  z.object({ type: z.literal('left'), id: z.string() }),
  z.object({ type: z.literal('cursor'), id: z.string(), cursor: CursorSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /** Answer to a ping: `t` is the server clock when it was handled. */
  z.object({ type: z.literal('pong'), id: z.number().int().nonnegative(), t0: z.number().finite(), t: z.number().finite() }),
  /** The room's transport changed. `by` is who caused it, or null for the server. */
  z.object({ type: z.literal('transport'), transport: TransportSchema, by: z.string().nullable() }),
]);

export type Cursor = z.infer<typeof CursorSchema>;
export type Column = Cursor['column'];
export type Peer = z.infer<typeof PeerSchema>;
export type Landing = z.infer<typeof LandingSchema>;
export type ScheduledOp = z.infer<typeof ScheduledOpSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type OpMessage = Extract<ClientMessage, { type: 'op' }>;
export type ServerOpMessage = Extract<ServerMessage, { type: 'op' }>;

export function parseClientMessage(raw: string): ClientMessage | null {
  return parseJson(raw, ClientMessageSchema);
}

export function parseServerMessage(raw: string): ServerMessage | null {
  return parseJson(raw, ServerMessageSchema);
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
