import { describe, expect, it } from 'vitest';
import {
  applyOp,
  demoSong,
  emptySong,
  framesPerRow,
  midiToFreq,
  NOTE_OFF,
  noteName,
  parseNote,
  parseOp,
  parseSong,
} from './index';

describe('applyOp', () => {
  it('sets a note without mutating the original song', () => {
    const song = emptySong();
    const next = applyOp(song, { type: 'setNote', channel: 1, row: 4, note: 60 });
    expect(next.cells[1]![4]).toEqual({ note: 60, volume: null });
    expect(song.cells[1]![4]).toEqual({ note: null, volume: null });
  });

  it('shares untouched columns', () => {
    const song = emptySong();
    const next = applyOp(song, { type: 'setVolume', channel: 0, row: 0, volume: 9 });
    expect(next.cells[0]).not.toBe(song.cells[0]);
    expect(next.cells[1]).toBe(song.cells[1]);
  });

  it('ignores ops outside the song', () => {
    const song = emptySong({ rows: 16 });
    expect(applyOp(song, { type: 'setNote', channel: 0, row: 20, note: 60 })).toBe(song);
  });

  it('merges channel settings and skips undefined fields', () => {
    const song = emptySong();
    const next = applyOp(song, { type: 'setChannel', channel: 3, settings: { shortNoise: true, decay: undefined } });
    expect(next.channels[3]).toEqual({ duty: 2, decay: 0, shortNoise: true });
  });

  it('clears both columns of a cell', () => {
    let song = applyOp(emptySong(), { type: 'setNote', channel: 2, row: 1, note: 45 });
    song = applyOp(song, { type: 'setVolume', channel: 2, row: 1, volume: 3 });
    song = applyOp(song, { type: 'clearCell', channel: 2, row: 1 });
    expect(song.cells[2]![1]).toEqual({ note: null, volume: null });
  });
});

describe('parseOp', () => {
  it('accepts a valid op', () => {
    expect(parseOp({ type: 'setBpm', bpm: 150 })).toEqual({ type: 'setBpm', bpm: 150 });
  });

  it.each([
    { type: 'setBpm', bpm: 9000 },
    { type: 'setNote', channel: 4, row: 0, note: 60 },
    { type: 'setVolume', channel: 0, row: 0, volume: 16 },
    { type: 'dropTables' },
    'nope',
  ])('rejects %j', (data) => {
    expect(parseOp(data)).toBeNull();
  });
});

describe('songs', () => {
  it('the demo song is valid', () => {
    expect(parseSong(demoSong())).not.toBeNull();
  });

  it('rejects a song whose columns are the wrong length', () => {
    const song = emptySong({ rows: 8 });
    song.cells[0]!.pop();
    expect(parseSong(song)).toBeNull();
  });
});

describe('notes', () => {
  it('names notes tracker-style', () => {
    expect(noteName(60)).toBe('C-4');
    expect(noteName(70)).toBe('A#4');
    expect(noteName(NOTE_OFF)).toBe('===');
  });

  it('round-trips every note name', () => {
    for (let note = 0; note <= 127; note++) expect(parseNote(noteName(note))).toBe(note);
  });

  it('tunes A-4 to 440 Hz', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(81)).toBeCloseTo(880);
  });
});

describe('timing', () => {
  it('computes frames per row', () => {
    expect(framesPerRow(48000, 120, 4)).toBe(6000);
  });
});
