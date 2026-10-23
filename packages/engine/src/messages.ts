import type { Song } from '@duty-cycle/protocol/core';
import type { QueuedOp, Timing } from './sequencer';

/** Main thread → AudioWorklet. */
export type ToWorklet =
  /** The audible song, plus edits waiting for their rows. */
  | { type: 'song'; song: Song; queue: QueuedOp[] }
  /** Where rows fall on the audio clock; null stops playback. */
  | { type: 'timing'; timing: Timing | null }
  | { type: 'preview'; channel: number; note: number; volume: number }
  | { type: 'release'; channel: number }
  | { type: 'mutes'; mutes: boolean[] };

/** AudioWorklet → main thread. */
export type FromWorklet =
  | { type: 'row'; row: number; absRow: number; frame: number }
  | { type: 'stopped' };

export const PROCESSOR_NAME = 'duty-cycle-chip';
