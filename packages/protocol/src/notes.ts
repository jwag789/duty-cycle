import { MAX_NOTE, NOTE_OFF } from './constants';

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** Equal temperament, A-4 (MIDI 69) = 440 Hz. */
export function midiToFreq(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/** Tracker-style three-character name: "C-4", "F#3", "===" for note off. MIDI 60 is C-4. */
export function noteName(note: number): string {
  if (note === NOTE_OFF) return '===';
  return `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

/** Inverse of noteName for real notes. Returns null for anything else. */
export function parseNote(name: string): number | null {
  const match = /^([A-G])([-#])(-?\d)$/.exec(name);
  if (!match) return null;
  const index = NAMES.indexOf(`${match[1]}${match[2]}`);
  if (index < 0) return null;
  const note = (Number(match[3]) + 1) * 12 + index;
  return note >= 0 && note <= MAX_NOTE ? note : null;
}
