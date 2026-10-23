import type { Song } from '@duty-cycle/protocol/core';
import type { Timing } from './sequencer';

/** Main thread → AudioWorklet. */
export type ToWorklet =
  | { type: 'song'; song: Song }
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
