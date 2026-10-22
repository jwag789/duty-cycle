import { CHANNELS, MAX_NOTE, MAX_VOLUME, NOTE_OFF, type Column, type Cursor, type Op, type Song } from '@duty-cycle/protocol';

export type { Column, Cursor };

export interface EditorState {
  cursor: Cursor;
  /** Octave of the lower keyboard row (Z = C). */
  octave: number;
  /** Rows the cursor moves down after an entry. */
  step: number;
}

export interface KeyInput {
  code: string;
  key: string;
  shift: boolean;
  repeat: boolean;
}

export interface KeyResult {
  handled: boolean;
  state: EditorState;
  ops: Op[];
  preview?: { channel: number; note: number; volume: number };
  togglePlay?: boolean;
}

export const MIN_OCTAVE = 0;
export const MAX_OCTAVE = 8;
export const MAX_STEP = 16;
const PAGE_ROWS = 16;

export const INITIAL_EDITOR: EditorState = {
  cursor: { row: 0, channel: 0, column: 'note' },
  octave: 4,
  step: 1,
};

/**
 * The classic tracker layout: the bottom letter row is one octave of a piano
 * (Z = C, S = C#, X = D…) and the top row is the octave above. Physical key
 * codes, so it works the same on any keyboard layout.
 */
const NOTE_KEYS: Readonly<Record<string, number>> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

const NOTE_OFF_KEY = 'Digit1';
const COLUMNS: readonly Column[] = ['note', 'volume'];

export function isNoteKey(code: string): boolean {
  return code in NOTE_KEYS;
}

/** Pure keyboard handling: given the editor and song, what does this key do? */
export function handleKey(state: EditorState, song: Song, input: KeyInput): KeyResult {
  const { cursor } = state;
  const handled = (next: EditorState, extra: Partial<KeyResult> = {}): KeyResult => ({
    handled: true,
    state: next,
    ops: [],
    ...extra,
  });
  const moveTo = (patch: Partial<Cursor>): EditorState => ({ ...state, cursor: { ...cursor, ...patch } });
  const advanced = (): EditorState => moveTo({ row: wrap(cursor.row + state.step, song.rows) });

  switch (input.code) {
    case 'ArrowUp':
      return handled(moveTo({ row: wrap(cursor.row - 1, song.rows) }));
    case 'ArrowDown':
      return handled(moveTo({ row: wrap(cursor.row + 1, song.rows) }));
    case 'PageUp':
      return handled(moveTo({ row: Math.max(0, cursor.row - PAGE_ROWS) }));
    case 'PageDown':
      return handled(moveTo({ row: Math.min(song.rows - 1, cursor.row + PAGE_ROWS) }));
    case 'Home':
      return handled(moveTo({ row: 0 }));
    case 'End':
      return handled(moveTo({ row: song.rows - 1 }));
    case 'ArrowLeft':
    case 'ArrowRight': {
      const slots = CHANNELS.length * COLUMNS.length;
      const slot = wrap(cursor.channel * COLUMNS.length + COLUMNS.indexOf(cursor.column) + (input.code === 'ArrowLeft' ? -1 : 1), slots);
      return handled(moveTo({ channel: Math.floor(slot / COLUMNS.length), column: COLUMNS[slot % COLUMNS.length]! }));
    }
    case 'Tab':
      return handled(moveTo({ channel: wrap(cursor.channel + (input.shift ? -1 : 1), CHANNELS.length), column: 'note' }));
    case 'Space':
      return input.repeat ? handled(state) : handled(state, { togglePlay: true });
    case 'BracketLeft':
      return handled({ ...state, octave: Math.max(MIN_OCTAVE, state.octave - 1) });
    case 'BracketRight':
      return handled({ ...state, octave: Math.min(MAX_OCTAVE, state.octave + 1) });
    case 'Minus':
      return handled({ ...state, step: Math.max(0, state.step - 1) });
    case 'Equal':
      return handled({ ...state, step: Math.min(MAX_STEP, state.step + 1) });
    case 'Delete':
    case 'Backspace':
    case 'Period': {
      const { channel, row } = cursor;
      const op: Op =
        cursor.column === 'note'
          ? { type: 'setNote', channel, row, note: null }
          : { type: 'setVolume', channel, row, volume: null };
      return handled(advanced(), { ops: [op] });
    }
  }

  // Holding a note key would otherwise fill the column with copies.
  if (input.repeat) return handled(state);

  const { channel, row } = cursor;
  if (cursor.column === 'note') {
    if (input.code === NOTE_OFF_KEY) {
      return handled(advanced(), { ops: [{ type: 'setNote', channel, row, note: NOTE_OFF }] });
    }
    const offset = NOTE_KEYS[input.code];
    if (offset === undefined) return { handled: false, state, ops: [] };
    const note = (state.octave + 1) * 12 + offset;
    if (note > MAX_NOTE) return handled(state);
    const volume = song.cells[channel]?.[row]?.volume ?? MAX_VOLUME;
    return handled(advanced(), {
      ops: [{ type: 'setNote', channel, row, note }],
      preview: { channel, note, volume },
    });
  }

  if (/^[0-9a-f]$/i.test(input.key)) {
    const volume = Number.parseInt(input.key, 16);
    return handled(advanced(), { ops: [{ type: 'setVolume', channel, row, volume }] });
  }
  return { handled: false, state, ops: [] };
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}
