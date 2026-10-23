import { describe, expect, it } from 'vitest';
import { emptySong } from './factory';
import { historySpan, replayFrame, replayStart, replayTo, type History } from './history';
import type { Op } from './ops';

const note = (row: number, value: number): Op => ({ type: 'setNote', channel: 0, row, note: value });
const playing = { playing: true, epoch: 1, anchorTime: 1_000, anchorRow: 0, bpm: 120, rowsPerBeat: 4 }; // 125 ms rows

const history: History = {
  room: 'room123',
  seed: emptySong(),
  events: [
    { kind: 'op', time: 100, seq: 1, op: note(0, 60), at: null, by: 'Ada' },
    { kind: 'transport', time: 800, transport: playing, by: 'Ada' },
    // Made at 1_200, heard from row 8 (t = 2_000).
    { kind: 'op', time: 1_200, seq: 2, op: note(1, 62), at: { epoch: 1, row: 8 }, by: 'Ben' },
    { kind: 'transport', time: 3_000, transport: { ...playing, playing: false }, by: 'Ben' },
  ],
};

const cell = (song: { cells: { note: number | null }[][] }, row: number) => song.cells[0]![row]!.note;

describe('replay', () => {
  it('applies events up to a time', () => {
    const cursor = replayTo(history, replayStart(history), 500);
    expect(cursor.next).toBe(1);
    expect(cell(replayFrame(cursor, 500).song, 0)).toBe(60);
    expect(replayFrame(cursor, 500).transport.playing).toBe(false);
  });

  it('shows a scheduled edit at once but makes it audible only from its row', () => {
    const cursor = replayTo(history, replayStart(history), 1_500);
    const before = replayFrame(cursor, 1_500);
    expect(cell(before.song, 1)).toBe(62);
    expect(cell(before.audible, 1)).toBeNull();
    expect(before.queue).toEqual([{ row: 8, op: note(1, 62) }]);

    const after = replayFrame(replayTo(history, cursor, 2_000), 2_000);
    expect(cell(after.audible, 1)).toBe(62);
    expect(after.queue).toEqual([]);
  });

  it('seeks backwards by starting over', () => {
    const late = replayTo(history, replayStart(history), 2_500);
    const back = replayTo(history, late, 500);
    expect(back.next).toBe(1);
    expect(cell(replayFrame(back, 500).song, 1)).toBeNull();
  });

  it('spans the first event to a little after the last', () => {
    expect(historySpan(history, 1_000)).toEqual({ start: 100, end: 4_000 });
    expect(historySpan({ ...history, events: [] })).toBeNull();
  });
});
