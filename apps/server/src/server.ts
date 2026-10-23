import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE,
  demoSong,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  type ServerMessage,
  type Song,
} from '@duty-cycle/protocol';
import { Room } from './room';
import { serveStatic } from './static';

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

  const rooms = new Map<string, Room>();
  const idleTimers = new Map<string, NodeJS.Timeout>();

  const openRoom = (id: string, seed: Song | undefined): Room | null => {
    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
    const existing = rooms.get(id);
    if (existing) return existing;
    if (rooms.size >= maxRooms) return null;
    const room = new Room(id, seed ?? demoSong(), now);
    rooms.set(id, room);
    return room;
  };

  const releaseRoom = (room: Room) => {
    if (room.size > 0) return;
    // Rooms live in memory until M4 adds Postgres, so keep an empty one around
    // long enough for a refresh or a dropped connection to come back to it.
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
    if (options.staticDir) {
      void serveStatic(options.staticDir, req, res);
      return;
    }
    res.writeHead(404).end();
  });

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
        clearTimeout(helloTimer);
        if (message?.type !== 'hello') {
          socket.close(CLOSE.badHello, 'Expected hello');
          return;
        }
        const room = openRoom(message.room, message.seed);
        if (!room) {
          socket.close(CLOSE.serverFull, 'Server is full');
          return;
        }
        if (room.isFull()) {
          socket.close(CLOSE.roomFull, 'Room is full');
          releaseRoom(room);
          return;
        }
        const id = randomUUID().slice(0, 8);
        room.join({ id, send }, message.name);
        session = { room, id };
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
