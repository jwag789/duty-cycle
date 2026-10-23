import { secondsPerRow } from './timing';

/**
 * The shared playhead, in server time (milliseconds). At `anchorTime` the room
 * is at absolute row `anchorRow` (not wrapped to the pattern length), and rows
 * advance at the given tempo from there. Every client turns this into the same
 * audible moments, so everyone hears row N at the same instant.
 */
export interface Transport {
  playing: boolean;
  anchorTime: number;
  anchorRow: number;
  bpm: number;
  rowsPerBeat: number;
}

export const STOPPED: Transport = Object.freeze({ playing: false, anchorTime: 0, anchorRow: 0, bpm: 120, rowsPerBeat: 4 });

export function msPerRow(transport: Pick<Transport, 'bpm' | 'rowsPerBeat'>): number {
  return secondsPerRow(transport.bpm, transport.rowsPerBeat) * 1000;
}

/** Fractional absolute row at `time`. */
export function rowAt(transport: Transport, time: number): number {
  return transport.anchorRow + (time - transport.anchorTime) / msPerRow(transport);
}

export function timeOfRow(transport: Transport, row: number): number {
  return transport.anchorTime + (row - transport.anchorRow) * msPerRow(transport);
}

export function startTransport(tempo: Pick<Transport, 'bpm' | 'rowsPerBeat'>, fromRow: number, at: number): Transport {
  return { playing: true, anchorTime: at, anchorRow: fromRow, bpm: tempo.bpm, rowsPerBeat: tempo.rowsPerBeat };
}

export function stopTransport(transport: Transport): Transport {
  return transport.playing ? { ...transport, playing: false } : transport;
}

/**
 * Changes tempo without a jump. The new tempo takes over on the first row
 * boundary at or after `at`, at the moment the old tempo would have reached it.
 * `at` must leave everyone time to hear about the change before it lands.
 */
export function retempo(transport: Transport, tempo: Pick<Transport, 'bpm' | 'rowsPerBeat'>, at: number): Transport {
  if (transport.bpm === tempo.bpm && transport.rowsPerBeat === tempo.rowsPerBeat) return transport;
  if (!transport.playing) return { ...transport, bpm: tempo.bpm, rowsPerBeat: tempo.rowsPerBeat };
  const row = Math.max(transport.anchorRow, Math.ceil(rowAt(transport, at) - 1e-9));
  return { playing: true, anchorTime: timeOfRow(transport, row), anchorRow: row, bpm: tempo.bpm, rowsPerBeat: tempo.rowsPerBeat };
}

const DEFAULT_RTT_MS = 200;
const SAFETY_MS = 120;
const MIN_LEAD_MS = 150;
const MAX_LEAD_MS = 1500;

/**
 * How far ahead a play or tempo change is scheduled: the slowest player's
 * one-way delay plus a margin for jitter and the audio scheduler.
 */
export function leadTimeMs(roundTrips: readonly (number | null)[]): number {
  const known = roundTrips.filter((rtt): rtt is number => rtt !== null);
  const worst = known.length > 0 ? Math.max(...known) : DEFAULT_RTT_MS;
  return Math.min(MAX_LEAD_MS, Math.max(MIN_LEAD_MS, worst / 2 + SAFETY_MS));
}
