import { useCallback, useEffect, useState } from 'react';
import type { RoomConnection, RoomSnapshot } from '@duty-cycle/client';
import { retempo, startTransport, STOPPED, stopTransport, type Song, type Transport } from '@duty-cycle/protocol';

/** Solo playback starts this far ahead, so the first row isn't clipped. */
const SOLO_LEAD_MS = 30;
/** Clock samples needed before a room's Play is trusted. */
const MIN_CLOCK_SAMPLES = 3;

export interface Playback {
  transport: Transport;
  /** Reference clock minus performance.now(): the server's in a jam, 0 when solo. */
  offset: number;
  /** False in a jam until the clock estimate is usable. */
  ready: boolean;
  play: () => void;
  stop: () => void;
}

/**
 * One transport for the engine to follow. In a jam it's the room's, run by
 * the server on the server's clock. Solo, it's local, on performance.now().
 */
export function usePlayback(
  room: string | null,
  connection: RoomConnection | null,
  snapshot: RoomSnapshot,
  song: Song | null,
): Playback {
  const [solo, setSolo] = useState<Transport>(STOPPED);

  // Leaving or joining a jam stops whatever was playing solo.
  useEffect(() => setSolo((current) => stopTransport(current)), [room]);

  // Solo tempo changes land on the next row; in a jam the server does this.
  const bpm = song?.bpm;
  const rowsPerBeat = song?.rowsPerBeat;
  useEffect(() => {
    if (room || bpm === undefined || rowsPerBeat === undefined) return;
    setSolo((current) => retempo(current, { bpm, rowsPerBeat }, performance.now() + SOLO_LEAD_MS));
  }, [room, bpm, rowsPerBeat]);

  const play = useCallback(() => {
    if (room) connection?.play(0);
    else if (song) setSolo(startTransport(song, 0, performance.now() + SOLO_LEAD_MS));
  }, [room, connection, song]);

  const stop = useCallback(() => {
    if (room) connection?.stop();
    else setSolo((current) => stopTransport(current));
  }, [room, connection]);

  if (!room) return { transport: solo, offset: 0, ready: song !== null, play, stop };
  return {
    transport: snapshot.transport,
    offset: snapshot.clock?.offset ?? 0,
    ready: snapshot.status === 'live' && (snapshot.clock?.samples ?? 0) >= MIN_CLOCK_SAMPLES,
    play,
    stop,
  };
}
