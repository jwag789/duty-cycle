import type { Song } from '@duty-cycle/protocol/core';

/** Main thread → AudioWorklet. */
export type ToWorklet =
  | { type: 'song'; song: Song }
  | { type: 'play'; fromRow: number }
  | { type: 'stop' }
  | { type: 'preview'; channel: number; note: number; volume: number }
  | { type: 'release'; channel: number }
  | { type: 'mutes'; mutes: boolean[] };

/** AudioWorklet → main thread. */
export type FromWorklet =
  | { type: 'row'; row: number; frame: number }
  | { type: 'stopped' };

export const PROCESSOR_NAME = 'duty-cycle-chip';
