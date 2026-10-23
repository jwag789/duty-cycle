import { framesPerRow, type Song } from '@duty-cycle/protocol/core';
import type { ChipSynth } from './synth';

export interface RowEvent {
  /** Row within the pattern. */
  row: number;
  /** Rows since playback started; never wraps. */
  absRow: number;
  /** The absolute audio frame the row started on. */
  frame: number;
}

/** Absolute row `anchorRow` starts on `anchorFrame`, and rows are `framesPerRow` apart from there. */
export interface Timing {
  anchorFrame: number;
  anchorRow: number;
  framesPerRow: number;
}

// Keeps float error from pushing an exact boundary one frame late.
const EPSILON = 1e-6;

/**
 * Walks the pattern and triggers each row on an exact audio frame.
 *
 * Row times come from an anchor (anchorFrame + n × framesPerRow) rather than
 * from adding framesPerRow over and over, so a fractional row length never
 * drifts. The anchor comes from outside: in a jam it's the room's shared
 * transport mapped onto this machine's audio clock.
 *
 * Three kinds of new timing are handled differently:
 * - A start that's already late joins at the next row boundary. It doesn't
 *   rush through the rows it missed.
 * - A small correction (clock drift, a better clock estimate) moves the next
 *   boundary slightly. It never replays a row.
 * - A change anchored on a future row (a tempo change) waits until playback
 *   reaches that row, so every client switches on the same row.
 */
export class Sequencer {
  private song: Song;
  private current: Timing | null = null;
  private pending: Timing | null = null;
  private nextAbs = 0;
  private lastAbs: number | null = null;

  constructor(
    private readonly synth: ChipSynth,
    song: Song,
    private readonly onRow?: (event: RowEvent) => void,
  ) {
    this.song = song;
    synth.setSettings(song.channels);
  }

  get playing(): boolean {
    return this.current !== null;
  }

  /** Swaps in new notes and settings. Tempo comes from the timing, not the song. */
  setSong(song: Song): void {
    this.song = song;
    this.synth.setSettings(song.channels);
  }

  /** Follows `timing` from audio frame `frame` on, or stops when it's null. */
  setTiming(timing: Timing | null, frame: number): void {
    if (!timing) {
      this.stop();
      return;
    }
    if (!this.current) {
      this.current = timing;
      this.pending = null;
      this.lastAbs = null;
      this.nextAbs = Math.max(timing.anchorRow, firstRowFrom(timing, frame));
      return;
    }
    if (timing.anchorRow > this.nextAbs) {
      this.pending = timing;
      return;
    }
    this.current = timing;
    this.pending = null;
    const first = firstRowFrom(timing, frame);
    this.nextAbs = this.lastAbs === null ? Math.max(timing.anchorRow, first) : Math.max(this.lastAbs + 1, first);
  }

  /** Plays from `fromRow` at the song's own tempo, starting exactly on `atFrame`. */
  play(fromRow: number, atFrame: number): void {
    this.stop();
    const rowFrames = framesPerRow(this.synth.sampleRate, this.song.bpm, this.song.rowsPerBeat);
    this.setTiming({ anchorFrame: atFrame, anchorRow: fromRow, framesPerRow: rowFrames }, atFrame);
  }

  stop(): void {
    this.current = null;
    this.pending = null;
    this.lastAbs = null;
    this.synth.releaseAll();
  }

  /** Advances one sample at absolute frame `frame` and returns it. */
  tick(frame: number): number {
    if (this.current) {
      if (this.pending && this.nextAbs >= this.pending.anchorRow) {
        this.current = this.pending;
        this.pending = null;
      }
      if (frame + EPSILON >= boundary(this.current, this.nextAbs)) this.trigger(frame);
    }
    return this.synth.render();
  }

  private trigger(frame: number): void {
    const abs = this.nextAbs;
    const row = ((abs % this.song.rows) + this.song.rows) % this.song.rows;
    this.song.cells.forEach((column, channel) => {
      const cell = column[row];
      if (cell) this.synth.applyCell(channel, cell);
    });
    this.onRow?.({ row, absRow: abs, frame });
    this.lastAbs = abs;
    // If we're behind schedule, skip to the next boundary still ahead of us
    // instead of firing the missed rows one sample apart.
    this.nextAbs = Math.max(abs + 1, firstRowFrom(this.current!, frame + 1));
  }
}

function boundary(timing: Timing, absRow: number): number {
  return timing.anchorFrame + (absRow - timing.anchorRow) * timing.framesPerRow;
}

/** The first absolute row whose boundary is at or after `frame`. */
function firstRowFrom(timing: Timing, frame: number): number {
  return Math.ceil(timing.anchorRow + (frame - timing.anchorFrame) / timing.framesPerRow - EPSILON);
}
