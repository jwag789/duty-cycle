import { describe, expect, it } from 'vitest';
import { applyOp, demoSong, emptySong, NOTE_OFF, type Song } from '@duty-cycle/protocol';
import { renderSong } from './render';
import { Sequencer } from './sequencer';
import { ChipSynth, stepLfsr } from './synth';

const SR = 48_000;

function withNotes(song: Song, notes: [channel: number, row: number, note: number][]): Song {
  return notes.reduce((s, [channel, row, note]) => applyOp(s, { type: 'setNote', channel, row, note }), song);
}

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / (to - from));
}

describe('sequencer timing', () => {
  it('starts each row on an exact frame', () => {
    const { rows } = renderSong(emptySong({ bpm: 120, rowsPerBeat: 4, rows: 32 }), { sampleRate: SR, frames: 6000 * 33 + 1 });
    expect(rows.slice(0, 4)).toEqual([
      { row: 0, frame: 0 },
      { row: 1, frame: 6000 },
      { row: 2, frame: 12000 },
      { row: 3, frame: 18000 },
    ]);
    // Wraps back to row 0 after the last row.
    expect(rows[32]).toEqual({ row: 0, frame: 192000 });
  });

  it('does not drift when a row is a fractional number of frames', () => {
    const rowFrames = (SR * 60) / (140 * 4); // 5142.857…
    const { rows } = renderSong(emptySong({ bpm: 140 }), { sampleRate: SR, frames: SR * 30 });
    for (const [n, event] of rows.entries()) {
      expect(event.frame).toBe(Math.max(0, Math.ceil(n * rowFrames - 1e-6)));
    }
  });

  it('re-anchors on the last row when the tempo changes', () => {
    const synth = new ChipSynth(SR, emptySong().channels);
    const frames: number[] = [];
    const sequencer = new Sequencer(synth, emptySong({ bpm: 120 }), ({ frame }) => frames.push(frame));
    sequencer.play(0, 0);
    for (let f = 0; f <= 6000; f++) sequencer.tick(f); // rows at 0 and 6000
    sequencer.setSong(emptySong({ bpm: 240 })); // 3000 frames per row from here
    for (let f = 6001; f <= 12000; f++) sequencer.tick(f);
    expect(frames).toEqual([0, 6000, 9000, 12000]);
  });
});

describe('voices', () => {
  it('plays A-4 on a pulse channel at 440 Hz', () => {
    const song = withNotes(emptySong(), [[0, 0, 69]]);
    const { samples } = renderSong(song, { sampleRate: SR, frames: SR });
    // Count rising zero crossings over the last half second, after the filters settle.
    let crossings = 0;
    for (let i = SR / 2 + 1; i < SR; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) crossings++;
    expect(crossings * 2).toBeGreaterThanOrEqual(438);
    expect(crossings * 2).toBeLessThanOrEqual(442);
  });

  it('is silent when nothing is written', () => {
    const { samples } = renderSong(emptySong(), { sampleRate: SR, frames: 4800 });
    expect(rms(samples, 0, 4800)).toBe(0);
  });

  it('releases a note on note off, without a click', () => {
    // 120 bpm: row 1 starts at frame 6000.
    const song = withNotes(emptySong(), [[2, 0, 57], [2, 1, NOTE_OFF]]);
    const { samples } = renderSong(song, { sampleRate: SR, frames: 9000 });
    expect(rms(samples, 3000, 6000)).toBeGreaterThan(0.05);
    expect(rms(samples, 7000, 9000)).toBeLessThan(0.001);
    // The release is a ramp: no sample-to-sample jump bigger than the waveform's own steps.
    for (let i = 6000; i < 6200; i++) expect(Math.abs(samples[i]! - samples[i - 1]!)).toBeLessThan(0.1);
  });

  it('silences muted channels', () => {
    const song = withNotes(emptySong(), [[1, 0, 60]]);
    const { samples } = renderSong(song, { sampleRate: SR, frames: 4800, mutes: [false, true, false, false] });
    expect(rms(samples, 0, 4800)).toBe(0);
  });

  it('decays held notes when the channel decays', () => {
    let song = withNotes(emptySong(), [[0, 0, 60]]);
    song = applyOp(song, { type: 'setChannel', channel: 0, settings: { decay: 15 } });
    const { samples } = renderSong(song, { sampleRate: SR, frames: SR / 4 });
    // decay 15 empties a full-volume note in 125 ms.
    expect(rms(samples, 0, 2400)).toBeGreaterThan(0.05);
    expect(rms(samples, SR / 8 + 480, SR / 4)).toBeLessThan(0.001);
  });
});

describe('noise LFSR', () => {
  function period(short: boolean): number {
    const start = 1;
    let register = stepLfsr(start, short);
    let steps = 1;
    while (register !== start) {
      register = stepLfsr(register, short);
      steps++;
    }
    return steps;
  }

  it('repeats every 32767 steps in long mode', () => {
    expect(period(false)).toBe(32767);
  });

  it('repeats every 93 steps in short mode', () => {
    expect(period(true)).toBe(93);
  });
});

describe('determinism', () => {
  it('renders the same song to identical samples every time', () => {
    const a = renderSong(demoSong(), { sampleRate: SR, frames: SR * 2 });
    const b = renderSong(demoSong(), { sampleRate: SR, frames: SR * 2 });
    expect(a.samples).toEqual(b.samples);
    expect(rms(a.samples, 0, SR * 2)).toBeGreaterThan(0.05);
  });
});
