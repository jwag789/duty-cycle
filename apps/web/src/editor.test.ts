import { describe, expect, it } from 'vitest';
import { emptySong, NOTE_OFF } from '@duty-cycle/protocol';
import { handleKey, INITIAL_EDITOR, type EditorState, type KeyInput } from './editor';

const song = emptySong({ rows: 32 });

function press(code: string, state: EditorState = INITIAL_EDITOR, extra: Partial<KeyInput> = {}) {
  return handleKey(state, song, { code, key: extra.key ?? '', shift: false, repeat: false, ...extra });
}

function at(row: number, channel = 0, column: 'note' | 'volume' = 'note'): EditorState {
  return { ...INITIAL_EDITOR, cursor: { row, channel, column } };
}

describe('note entry', () => {
  it('Z enters C in the current octave, previews it, and steps down', () => {
    const result = press('KeyZ');
    expect(result.ops).toEqual([{ type: 'setNote', channel: 0, row: 0, note: 60 }]);
    expect(result.preview).toEqual({ channel: 0, note: 60, volume: 15 });
    expect(result.state.cursor.row).toBe(1);
  });

  it('the top letter row is the octave above', () => {
    expect(press('KeyQ').ops[0]).toMatchObject({ note: 72 });
    expect(press('Digit2').ops[0]).toMatchObject({ note: 73 });
  });

  it('follows the octave setting', () => {
    expect(press('KeyZ', { ...INITIAL_EDITOR, octave: 2 }).ops[0]).toMatchObject({ note: 36 });
  });

  it('1 writes a note off', () => {
    expect(press('Digit1').ops[0]).toMatchObject({ note: NOTE_OFF });
  });

  it('ignores notes above MIDI 127', () => {
    const result = press('KeyP', { ...INITIAL_EDITOR, octave: 8 });
    expect(result.handled).toBe(true);
    expect(result.ops).toEqual([]);
  });

  it('ignores key repeat so a held key writes one note', () => {
    expect(press('KeyZ', INITIAL_EDITOR, { repeat: true }).ops).toEqual([]);
  });

  it('wraps from the last row to the first', () => {
    expect(press('KeyZ', at(31)).state.cursor.row).toBe(0);
  });
});

describe('volume entry', () => {
  it('a hex digit sets the volume', () => {
    const result = press('KeyB', at(3, 2, 'volume'), { key: 'b' });
    expect(result.ops).toEqual([{ type: 'setVolume', channel: 2, row: 3, volume: 11 }]);
  });

  it('note keys that are not hex do nothing in the volume column', () => {
    expect(press('KeyZ', at(0, 0, 'volume'), { key: 'z' }).handled).toBe(false);
  });
});

describe('clearing', () => {
  it('Delete clears only the column under the cursor', () => {
    expect(press('Delete', at(5, 1, 'note')).ops).toEqual([{ type: 'setNote', channel: 1, row: 5, note: null }]);
    expect(press('Delete', at(5, 1, 'volume')).ops).toEqual([{ type: 'setVolume', channel: 1, row: 5, volume: null }]);
  });
});

describe('navigation', () => {
  it('Right walks note → volume → next channel', () => {
    const volume = press('ArrowRight').state;
    expect(volume.cursor).toMatchObject({ channel: 0, column: 'volume' });
    expect(press('ArrowRight', volume).state.cursor).toMatchObject({ channel: 1, column: 'note' });
  });

  it('Left from the first column wraps to the last', () => {
    expect(press('ArrowLeft').state.cursor).toMatchObject({ channel: 3, column: 'volume' });
  });

  it('Tab and Shift+Tab move between channels', () => {
    expect(press('Tab').state.cursor.channel).toBe(1);
    expect(press('Tab', INITIAL_EDITOR, { shift: true }).state.cursor.channel).toBe(3);
  });

  it('clamps octave and step', () => {
    expect(press('BracketLeft', { ...INITIAL_EDITOR, octave: 0 }).state.octave).toBe(0);
    expect(press('Minus', { ...INITIAL_EDITOR, step: 0 }).state.step).toBe(0);
  });

  it('Space toggles playback', () => {
    expect(press('Space').togglePlay).toBe(true);
  });
});
