import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE,
  demoSong,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  ROOM_ID_PATTERN,
  type HistoryEvent,
  type ServerMessage,
  type Song,
} from '@duty-cycle/protocol';
import { Room } from './room';
import { serveStatic } from './static';
import { SNAPSHOT_EVERY, type RoomStore } from './store';

export interface ServerOptions {
  port: number;
  host?: string;
  /** Built web app to serve alongside the socket, or null for socket only. */
  staticDir?: string | null;
  /** How long an empty room is kept before it's dropped. */
  idleRoomMs?: number;
  maxRooms?: number;
  /** Per-connection message budget: a burst of `burst`, refilled at `perSecond`. */
  rateLimit?: { burst: number; perSecond: number };
  /** The server clock, in ms. Clients sync to it; tests can replace it. */
  now?: () => number;
  /** Where rooms and their event logs persist. Without one, rooms live in memory only. */
  store?: RoomStore | null;
}

export interface RunningServer {
  readonly port: number;
  readonly rooms: ReadonlyMap<string, Room>;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 30_000;

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const idleRoomMs = options.idleRoomMs ?? 10 * 60_000;
  const maxRooms = options.maxRooms ?? 1_000;
  const rateLimit = options.rateLimit ?? { burst: 120, perSecond: 60 };
  const now = options.now ?? (() => performance.timeOrigin + performance.now());

  const store = options.store ?? null;
  const rooms = new Map<string, Room>();
  const loading = new Map<string, Promise<Room | null>>();
  const idleTimers = new Map<string, NodeJS.Timeout>();
  // One write queue per room, so its events reach the database in order
  // without the music ever waiting on a write.
  const writes = new Map<string, Promise<void>>();

  const enqueueWrite = (roomId: string, write: () => Promise<void>) => {
    const previous = writes.get(roomId) ?? Promise.resolve();
    const next = previous.then(write).catch((err: unknown) => {
      console.error(`[duty-cycle] failed to save room ${roomId}:`, err);
    });
    writes.set(roomId, next);
  };

  const persist = (room: Room, event: HistoryEvent) => {
    if (!store) return;
    enqueueWrite(room.id, () => store.appendEvent(room.id, event));
    if (event.kind === 'op' && event.seq % SNAPSHOT_EVERY === 0) {
      const { song, seq } = room.snapshot();
      enqueueWrite(room.id, () => store.saveSnapshot(room.id, seq, song));
    }
  };

  const createRoom = async (id: string, seed: Song | undefined): Promise<Room | null> => {
    if (rooms.size >= maxRooms) return null;
    const saved = store ? await store.loadRoom(id) : null;
    const song = saved?.song ?? seed ?? demoSong();
    if (store && !saved) await store.createRoom(id, song);
    const room: Room = new Room(id, song, {
      now,
      seq: saved?.seq ?? 0,
      transport: saved?.transport ?? undefined,
      onEvent: (event) => persist(room, event),
    });
    // The server stopped mid-song last time: note that the music stopped.
    if (saved?.transport?.playing) {
      persist(room, { kind: 'transport', time: now(), transport: { ...saved.transport, playing: false }, by: null });
    }
    rooms.set(id, room);
    return room;
  };

  /** The room, from memory, the database, or new. Concurrent joins share one load. */
  const openRoom = (id: string, seed: Song | undefined): Promise<Room | null> => {
    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
    const existing = rooms.get(id);
    if (existing) return Promise.resolve(existing);
    let pending = loading.get(id);
    if (!pending) {
      pending = createRoom(id, seed).finally(() => loading.delete(id));
      loading.set(id, pending);
    }
    return pending;
  };

  const releaseRoom = (room: Room) => {
    if (room.size > 0) return;
    // Keep an empty room in memory for a while, so a refresh or a dropped
    // connection comes straight back to it. It's in the database either way.
    idleTimers.set(
      room.id,
      setTimeout(() => {
        idleTimers.delete(room.id);
        if (room.size === 0) rooms.delete(room.id);
      }, idleRoomMs),
    );
  };

  const http: Server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    const historyRoute = /^\/api\/rooms\/([^/]+)\/history$/.exec(req.url ?? '');
    if (historyRoute) {
      void serveHistory(historyRoute[1]!, res);
      return;
    }
    if (options.staticDir) {
      void serveStatic(options.staticDir, req, res);
      return;
    }
    res.writeHead(404).end();
  });

  const serveHistory = async (id: string, res: ServerResponse) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
    if (!ROOM_ID_PATTERN.test(id)) return json(404, { error: 'No such room' });
    if (!store) return json(404, { error: 'This server keeps no history' });
    try {
      await writes.get(id); // Include anything still being written.
      const history = await store.history(id);
      if (history) json(200, history);
      else json(404, { error: 'No such room' });
    } catch (err) {
      console.error('[duty-cycle] history failed:', err);
      json(500, { error: 'Could not load history' });
    }
  };

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (socket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));

    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const bucket = new TokenBucket(rateLimit.burst, rateLimit.perSecond);
    let session: { room: Room; id: string } | null = null;
    let joining = false;
    let closed = false;
    const helloTimer = setTimeout(() => socket.close(CLOSE.badHello, 'No hello'), HELLO_TIMEOUT_MS);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text only');
        return;
      }
      if (!bucket.take()) {
        send({ type: 'error', message: 'Too many messages; slow down' });
        return;
      }
      const message = parseClientMessage(data.toString());

      if (!session) {
        // Loading a room from the database takes a moment; nothing else counts until it's done.
        if (joining) return;
        clearTimeout(helloTimer);
        if (message?.type !== 'hello') {
          socket.close(CLOSE.badHello, 'Expected hello');
          return;
        }
        joining = true;
        const { name } = message;
        void openRoom(message.room, message.seed).then(
          (room) => {
            joining = false;
            if (!room) {
              socket.close(CLOSE.serverFull, 'Server is full');
              return;
            }
            if (closed || room.isFull()) {
              if (!closed) socket.close(CLOSE.roomFull, 'Room is full');
              releaseRoom(room);
              return;
            }
            const id = randomUUID().slice(0, 8);
            room.join({ id, send }, name);
            session = { room, id };
          },
          (err: unknown) => {
            console.error('[duty-cycle] could not open room:', err);
            socket.close(1011, 'Could not open room');
          },
        );
        return;
      }

      switch (message?.type) {
        case 'op':
          session.room.applyClientOp(session.id, message.clientSeq, message.op);
          break;
        case 'cursor':
          session.room.moveCursor(session.id, message.cursor);
          break;
        case 'ping':
          // Stamped and answered straight away: any delay here becomes clock error.
          send({ type: 'pong', id: message.id, t0: message.t0, t: now() });
          session.room.noteRoundTrip(session.id, message.rtt);
          break;
        case 'transport':
          if (message.action === 'play') session.room.play(session.id, message.fromRow);
          else session.room.stop(session.id);
          break;
        case 'hello':
          send({ type: 'error', message: 'Already joined' });
          break;
        default:
          send({ type: 'error', message: 'Invalid message' });
      }
    });

    socket.on('close', () => {
      closed = true;
      clearTimeout(helloTimer);
      if (!session) return;
      session.room.leave(session.id);
      releaseRoom(session.room);
      session = null;
    });
  });

  // Drop connections that stop answering pings (sleeping laptops, dead Wi-Fi).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.get(socket)) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve));

  return {
    port: (http.address() as AddressInfo).port,
    rooms,
    close: async () => {
      clearInterval(heartbeat);
      for (const timer of idleTimers.values()) clearTimeout(timer);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
      // Let every queued write finish; closing the store is its owner's job.
      await Promise.all(writes.values());
    },
  };
}

class TokenBucket {
  private tokens: number;
  private last = performance.now();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
