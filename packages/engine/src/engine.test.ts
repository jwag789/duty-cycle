import { describe, expect, it } from 'vitest';
import { applyOp, demoSong, emptySong, NOTE_OFF, type Song } from '@duty-cycle/protocol';
import { renderSong } from './render';
import { Sequencer, type RowEvent, type Timing } from './sequencer';
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
      { row: 0, absRow: 0, frame: 0 },
      { row: 1, absRow: 1, frame: 6000 },
      { row: 2, absRow: 2, frame: 12000 },
      { row: 3, absRow: 3, frame: 18000 },
    ]);
    // Wraps back to row 0 after the last row; the absolute count keeps going.
    expect(rows[32]).toEqual({ row: 0, absRow: 32, frame: 192000 });
  });

  it('does not drift when a row is a fractional number of frames', () => {
    const rowFrames = (SR * 60) / (140 * 4); // 5142.857…
    const { rows } = renderSong(emptySong({ bpm: 140 }), { sampleRate: SR, frames: SR * 30 });
    for (const [n, event] of rows.entries()) {
      expect(event.frame).toBe(Math.max(0, Math.ceil(n * rowFrames - 1e-6)));
    }
  });

});

describe('following a shared timing', () => {
  /** Runs a sequencer over [from, to] and collects its rows, calling `at[frame]` first where given. */
  function run(to: number, at: Record<number, (s: Sequencer) => void>): RowEvent[] {
    const rows: RowEvent[] = [];
    const sequencer = new Sequencer(new ChipSynth(SR, emptySong().channels), emptySong(), (e) => rows.push(e));
    for (let frame = 0; frame <= to; frame++) {
      at[frame]?.(sequencer);
      sequencer.tick(frame);
    }
    return rows;
  }
  const t = (anchorFrame: number, anchorRow: number, framesPerRow = 6000): Timing => ({ anchorFrame, anchorRow, framesPerRow });

  it('waits for a start scheduled in the future', () => {
    const rows = run(12000, { 0: (s) => s.setTiming(t(5000, 0), 0) });
    expect(rows.map((r) => r.frame)).toEqual([5000, 11000]);
  });

  it('joins a late start at the next row, without rushing through the missed ones', () => {
    // Row 0 was due at frame -10000, so rows 0 and 1 are already gone.
    const rows = run(9000, { 0: (s) => s.setTiming(t(-10000, 0), 0) });
    expect(rows.map((r) => [r.absRow, r.frame])).toEqual([
      [2, 2000],
      [3, 8000],
    ]);
  });

  it('switches tempo exactly on the anchored row', () => {
    const rows = run(21000, {
      0: (s) => s.setTiming(t(0, 0), 0),
      // Arrives mid-row-0: from row 3 (frame 18000) on, rows are 3000 frames apart.
      100: (s) => s.setTiming(t(18000, 3, 3000), 100),
    });
    expect(rows.map((r) => [r.absRow, r.frame])).toEqual([
      [0, 0],
      [1, 6000],
      [2, 12000],
      [3, 18000],
      [4, 21000],
    ]);
  });

  it('absorbs small corrections without replaying or skipping a row', () => {
    const later = run(18000, { 0: (s) => s.setTiming(t(0, 0), 0), 7000: (s) => s.setTiming(t(50, 0), 7000) });
    // Pushed 50 frames later mid-row: row 2 moves with it.
    expect(later.map((r) => [r.absRow, r.frame])).toEqual([
      [0, 0],
      [1, 6000],
      [2, 12050],
    ]);

    // Pulling the schedule earlier than a row that already played doesn't play it again.
    const earlier = run(13000, { 0: (s) => s.setTiming(t(0, 0), 0), 6001: (s) => s.setTiming(t(-200, 0), 6001) });
    expect(earlier.map((r) => [r.absRow, r.frame])).toEqual([
      [0, 0],
      [1, 6000],
      [2, 11800],
    ]);
  });

  it('stops on a null timing', () => {
    const rows = run(13000, { 0: (s) => s.setTiming(t(0, 0), 0), 7000: (s) => s.setTiming(null, 7000) });
    expect(rows.map((r) => r.absRow)).toEqual([0, 1]);
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

describe('queued edits', () => {
  // 120 bpm, 4 rows per beat at 48 kHz: row 8 starts on frame 48000.
  const base = withNotes(emptySong(), [[2, 0, 45], [0, 0, 60]]);
  const edit = { row: 8, op: { type: 'setNote' as const, channel: 0, row: 8, note: 72 } };

  function render(actions: Record<number, (s: Sequencer) => void>): Float32Array {
    const synth = new ChipSynth(SR, base.channels);
    const sequencer = new Sequencer(synth, base);
    sequencer.play(0, 0);
    const out = new Float32Array(6000 * 12);
    for (let frame = 0; frame < out.length; frame++) {
      actions[frame]?.(sequencer);
      out[frame] = sequencer.tick(frame);
    }
    return out;
  }

  // The reference: the edited song swapped in exactly as row 8 starts.
  const reference = render({ 48000: (s) => s.setSong(applyOp(base, edit.op)) });

  it('plays an edit from its row, sample for sample, however early it arrived', () => {
    expect(render({ 10: (s) => s.setSong(base, [edit]) })).toEqual(reference);
    expect(render({ 30000: (s) => s.setSong(base, [edit]) })).toEqual(reference);
    expect(render({ 47999: (s) => s.setSong(base, [edit]) })).toEqual(reference);
  });

  it('cannot fix an edit that arrives after its row started', () => {
    expect(render({ 48001: (s) => s.setSong(base, [edit]) })).not.toEqual(reference);
  });

  it('applies everything at once when nothing is playing', () => {
    const playFrom8 = (setup: (s: Sequencer) => void) => {
      const sequencer = new Sequencer(new ChipSynth(SR, base.channels), base);
      setup(sequencer);
      sequencer.play(8, 0);
      return Float32Array.from({ length: 6000 }, (_, frame) => sequencer.tick(frame));
    };
    const queuedWhileStopped = playFrom8((s) => s.setSong(base, [edit]));
    const alreadyApplied = playFrom8((s) => s.setSong(applyOp(base, edit.op)));
    expect(queuedWhileStopped).toEqual(alreadyApplied);
  });
});
