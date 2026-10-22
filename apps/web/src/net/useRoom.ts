import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RoomConnection, type RoomSnapshot } from '@duty-cycle/client';
import type { Song } from '@duty-cycle/protocol';
import { playerName, socketUrl } from './session';

const IDLE: RoomSnapshot = { status: 'connecting', song: null, me: null, peers: [] };
const noSubscribe = () => () => {};
const idleSnapshot = () => IDLE;

/**
 * Joins `room` while it's non-null. `seed` is only sent by whoever starts the
 * jam; people arriving by link get whatever the room already holds.
 */
export function useRoom(room: string | null, seed: Song | undefined): { connection: RoomConnection | null; snapshot: RoomSnapshot } {
  const [connection, setConnection] = useState<RoomConnection | null>(null);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  useEffect(() => {
    if (!room) {
      setConnection(null);
      return;
    }
    const next = new RoomConnection({ url: socketUrl(), room, name: playerName(), seed: seedRef.current });
    next.connect();
    setConnection(next);
    return () => next.close();
  }, [room]);

  const snapshot = useSyncExternalStore(
    connection ? connection.subscribe : noSubscribe,
    connection ? connection.getSnapshot : idleSnapshot,
  );
  return { connection, snapshot };
}
