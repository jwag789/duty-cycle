import type { Song } from '@duty-cycle/protocol/core';
import { Sequencer, type RowEvent } from './sequencer';
import { ChipSynth } from './synth';

export interface RenderOptions {
  sampleRate: number;
  frames: number;
  fromRow?: number;
  mutes?: boolean[];
}

/**
 * Renders a song without Web Audio. The worklet runs this exact code path, which
 * is what makes it possible to prove two clients produce the same samples.
 */
export function renderSong(song: Song, options: RenderOptions): { samples: Float32Array; rows: RowEvent[] } {
  const synth = new ChipSynth(options.sampleRate, song.channels);
  if (options.mutes) synth.mutes = options.mutes.slice();
  const rows: RowEvent[] = [];
  const sequencer = new Sequencer(synth, song, (event) => rows.push(event));
  sequencer.play(options.fromRow ?? 0, 0);

  const samples = new Float32Array(options.frames);
  for (let frame = 0; frame < options.frames; frame++) samples[frame] = sequencer.tick(frame);
  return { samples, rows };
}
