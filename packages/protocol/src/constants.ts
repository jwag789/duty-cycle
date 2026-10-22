/** A cell note that releases whatever the channel is playing. */
export const NOTE_OFF = -1;
export const MAX_NOTE = 127;
export const MAX_VOLUME = 15;
export const MAX_DECAY = 15;
export const MAX_ROWS = 256;
export const MIN_BPM = 40;
export const MAX_BPM = 300;

export type ChannelKind = 'pulse' | 'triangle' | 'noise';

/** The four chip channels, in column order. */
export const CHANNELS: readonly { readonly name: string; readonly kind: ChannelKind }[] = [
  { name: 'Pulse 1', kind: 'pulse' },
  { name: 'Pulse 2', kind: 'pulse' },
  { name: 'Triangle', kind: 'triangle' },
  { name: 'Noise', kind: 'noise' },
];

/** Pulse duty cycles, indexed by ChannelSettings.duty. */
export const DUTY_CYCLES = [0.125, 0.25, 0.5, 0.75] as const;
