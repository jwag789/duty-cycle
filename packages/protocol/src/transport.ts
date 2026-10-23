import { secondsPerRow } from './timing';

/**
 * The shared playhead, in server time (milliseconds). At `anchorTime` the room
 * is at absolute row `anchorRow` (not wrapped to the pattern length), and rows
 * advance at the given tempo from there. Every client turns this into the same
 * audible moments, so everyone hears row N at the same instant.
 */
export interface Transport {
  playing: boolean;
  /**
   * Bumped on every start. Row numbers only mean something within one epoch:
   * a restart begins counting again, while a tempo change keeps counting.
   */
  epoch: number;
  anchorTime: number;
  anchorRow: number;
  bpm: number;
  rowsPerBeat: number;
}

export const STOPPED: Transport = Object.freeze({ playing: false, epoch: 0, anchorTime: 0, anchorRow: 0, bpm: 120, rowsPerBeat: 4 });

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

/** Starts a new epoch after `previous`, with row `fromRow` at time `at`. */
export function startTransport(
  previous: Transport,
  tempo: Pick<Transport, 'bpm' | 'rowsPerBeat'>,
  fromRow: number,
  at: number,
): Transport {
  return {
    playing: true,
    epoch: previous.epoch + 1,
    anchorTime: at,
    anchorRow: fromRow,
    bpm: tempo.bpm,
    rowsPerBeat: tempo.rowsPerBeat,
  };
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
  const row = rowStartingAfter(transport, at);
  return { ...transport, anchorTime: timeOfRow(transport, row), anchorRow: row, bpm: tempo.bpm, rowsPerBeat: tempo.rowsPerBeat };
}

/**
 * The first row that starts at or after `time`: the earliest row an edit made
 * now can land on, if `time` includes the lead.
 */
export function rowStartingAfter(transport: Transport, time: number): number {
  return Math.max(transport.anchorRow, Math.ceil(rowAt(transport, time) - 1e-9));
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
