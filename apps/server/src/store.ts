import { applyOp, type History, type HistoryEvent, type Op, type Song, type Transport } from '@duty-cycle/protocol';

/** The slice of a Postgres client this uses. `pg` and PGlite both fit it. */
export interface SqlClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  close(): Promise<void>;
}

/** Real Postgres, for production: `DATABASE_URL`. */
export async function connectPostgres(url: string): Promise<SqlClient> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url });
  return {
    query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as R[] }),
    close: () => pool.end(),
  };
}

/**
 * Postgres compiled to WebAssembly, running in-process. Used for local dev
 * (persisted under `dataDir`) and tests (in memory), so neither needs a database server.
 */
export async function openPglite(dataDir?: string): Promise<SqlClient> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  return {
    query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await db.query<R>(sql, params)).rows }),
    close: () => db.close(),
  };
}

const SCHEMA = [
  `create table if not exists rooms (
     id text primary key,
     seed jsonb not null,
     snapshot jsonb,
     snapshot_seq integer not null default 0,
     created_at timestamptz not null default now()
   )`,
  // Append-only. `id` gives the one true order; `seq` is the op's place in the room's order.
  `create table if not exists room_events (
     id bigserial primary key,
     room_id text not null references rooms (id) on delete cascade,
     kind text not null check (kind in ('op', 'transport')),
     seq integer,
     time double precision not null,
     body jsonb not null
   )`,
  `create index if not exists room_events_by_room on room_events (room_id, id)`,
  `create unique index if not exists room_events_op_seq on room_events (room_id, seq) where seq is not null`,
];

/** Take a snapshot every this many ops, so loading a room never replays its whole life. */
export const SNAPSHOT_EVERY = 100;

/**
 * Rooms and their event logs. The log is the source of truth: a room's song
 * is its seed with every op applied, and its history is the log itself.
 */
export class RoomStore {
  private constructor(private readonly sql: SqlClient) {}

  static async open(sql: SqlClient): Promise<RoomStore> {
    for (const statement of SCHEMA) await sql.query(statement);
    return new RoomStore(sql);
  }

  /**
   * The room's current song, op count and last transport, or null if it was
   * never created. The transport lets a restored room keep counting epochs.
   */
  async loadRoom(id: string): Promise<{ song: Song; seq: number; transport: Transport | null } | null> {
    const rooms = await this.sql.query<{ seed: Song; snapshot: Song | null; snapshot_seq: number }>(
      'select seed, snapshot, snapshot_seq from rooms where id = $1',
      [id],
    );
    const room = rooms.rows[0];
    if (!room) return null;
    const ops = await this.sql.query<{ seq: number; body: { op: Op } }>(
      `select seq, body from room_events where room_id = $1 and kind = 'op' and seq > $2 order by seq`,
      [id, room.snapshot_seq],
    );
    const song = ops.rows.reduce((current, row) => applyOp(current, row.body.op), room.snapshot ?? room.seed);
    const last = await this.sql.query<{ body: { transport: Transport } }>(
      `select body from room_events where room_id = $1 and kind = 'transport' order by id desc limit 1`,
      [id],
    );
    return { song, seq: ops.rows.at(-1)?.seq ?? room.snapshot_seq, transport: last.rows[0]?.body.transport ?? null };
  }

  async createRoom(id: string, seed: Song): Promise<void> {
    await this.sql.query('insert into rooms (id, seed) values ($1, $2::jsonb) on conflict (id) do nothing', [
      id,
      JSON.stringify(seed),
    ]);
  }

  async appendEvent(id: string, event: HistoryEvent): Promise<void> {
    await this.sql.query('insert into room_events (room_id, kind, seq, time, body) values ($1, $2, $3, $4, $5::jsonb)', [
      id,
      event.kind,
      event.kind === 'op' ? event.seq : null,
      event.time,
      JSON.stringify(event),
    ]);
  }

  async saveSnapshot(id: string, seq: number, song: Song): Promise<void> {
    await this.sql.query('update rooms set snapshot = $2::jsonb, snapshot_seq = $3 where id = $1 and snapshot_seq < $3', [
      id,
      JSON.stringify(song),
      seq,
    ]);
  }

  async history(id: string): Promise<History | null> {
    const rooms = await this.sql.query<{ seed: Song }>('select seed from rooms where id = $1', [id]);
    const room = rooms.rows[0];
    if (!room) return null;
    const events = await this.sql.query<{ body: HistoryEvent }>(
      'select body from room_events where room_id = $1 order by id',
      [id],
    );
    return { room: id, seed: room.seed, events: events.rows.map((row) => row.body) };
  }

  close(): Promise<void> {
    return this.sql.close();
  }
}
