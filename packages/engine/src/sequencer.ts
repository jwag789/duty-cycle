import { framesPerRow, type Song } from '@duty-cycle/protocol/core';
import type { ChipSynth } from './synth';

export interface RowEvent {
  row: number;
  /** The absolute audio frame the row started on. */
  frame: number;
}

/**
 * Walks the pattern and triggers each row on an exact audio frame.
 *
 * Row times are computed from an anchor (anchorFrame + n * framesPerRow) rather
 * than by adding framesPerRow over and over, so a fractional row length never
 * accumulates drift. A tempo change re-anchors on the last row that played.
 */
export class Sequencer {
  playing = false;
  private song: Song;
  private rowFrames: number;
  private nextRow = 0;
  private anchorFrame = 0;
  private rowsSinceAnchor = 0;
  private lastRowFrame = 0;

  constructor(
    private readonly synth: ChipSynth,
    song: Song,
    private readonly onRow?: (event: RowEvent) => void,
  ) {
    this.song = song;
    this.rowFrames = framesPerRow(synth.sampleRate, song.bpm, song.rowsPerBeat);
    synth.setSettings(song.channels);
  }

  setSong(song: Song): void {
    const rowFrames = framesPerRow(this.synth.sampleRate, song.bpm, song.rowsPerBeat);
    if (this.playing && rowFrames !== this.rowFrames) {
      this.anchorFrame = this.lastRowFrame;
      this.rowsSinceAnchor = 1;
    }
    this.song = song;
    this.rowFrames = rowFrames;
    if (this.nextRow >= song.rows) this.nextRow = 0;
    this.synth.setSettings(song.channels);
  }

  /** Starts playback so that `fromRow` begins exactly on `atFrame`. */
  play(fromRow: number, atFrame: number): void {
    this.playing = true;
    this.nextRow = fromRow % this.song.rows;
    this.anchorFrame = atFrame;
    this.rowsSinceAnchor = 0;
    this.lastRowFrame = atFrame;
  }

  stop(): void {
    this.playing = false;
    this.synth.releaseAll();
  }

  /** Advances one sample at absolute frame `frame` and returns it. */
  tick(frame: number): number {
    // The epsilon keeps float error from pushing an exact boundary one frame late.
    if (this.playing && frame + 1e-6 >= this.anchorFrame + this.rowsSinceAnchor * this.rowFrames) {
      this.triggerRow(frame);
    }
    return this.synth.render();
  }

  private triggerRow(frame: number): void {
    const row = this.nextRow;
    this.song.cells.forEach((column, channel) => {
      const cell = column[row];
      if (cell) this.synth.applyCell(channel, cell);
    });
    this.onRow?.({ row, frame });
    this.lastRowFrame = frame;
    this.nextRow = (row + 1) % this.song.rows;
    this.rowsSinceAnchor++;
  }
}
