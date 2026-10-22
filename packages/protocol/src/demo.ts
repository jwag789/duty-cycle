import { parseNote } from './notes';
import { NOTE_OFF } from './constants';
import { emptySong } from './factory';
import type { Song } from './song';

type Part = Record<number, string | [string, number]>;

/** Two bars in A minor (Am – F – C – G) so the tracker has something to play on first load. */
export function demoSong(): Song {
  const song = emptySong({ bpm: 140, rows: 32, rowsPerBeat: 4 });
  song.channels = [
    { duty: 1, decay: 2, shortNoise: false }, // lead: 25% duty, slow fade
    { duty: 0, decay: 5, shortNoise: false }, // arpeggio: thin 12.5%
    { duty: 2, decay: 0, shortNoise: false }, // bass: triangle holds
    { duty: 2, decay: 11, shortNoise: false }, // drums: fast fade
  ];

  const lead: Part = {
    0: 'E-5', 3: 'D-5', 4: 'C-5', 6: 'B-4',
    8: 'C-5', 10: 'A-4', 12: 'C-5', 14: 'D-5',
    16: 'E-5', 18: 'G-5', 20: 'E-5', 22: 'D-5',
    24: 'D-5', 26: 'B-4', 28: 'G-4', 30: 'B-4',
  };

  const chords = [
    ['A-3', 'C-4', 'E-4', 'C-4'],
    ['F-3', 'A-3', 'C-4', 'A-3'],
    ['C-4', 'E-4', 'G-4', 'E-4'],
    ['G-3', 'B-3', 'D-4', 'B-3'],
  ];
  const arp: Part = {};
  for (let row = 0; row < 32; row++) {
    arp[row] = [chords[Math.floor(row / 8)]![row % 4]!, 7];
  }

  const roots = ['A-2', 'F-2', 'C-3', 'G-2'];
  const bass: Part = {};
  for (let row = 0; row < 32; row += 2) {
    const root = roots[Math.floor(row / 8)]!;
    // Alternate root and the octave above it, eighth notes.
    bass[row] = row % 4 === 0 ? root : root.replace(/\d$/, (o) => String(Number(o) + 1));
  }

  // Noise pitch: C-4 is the lowest of its 16 steps, D#5 the highest.
  const drums: Part = {};
  for (let row = 0; row < 32; row += 2) {
    drums[row] = row % 8 === 0 ? ['D-4', 15] : row % 8 === 4 ? ['A-4', 12] : ['D#5', 5];
  }
  drums[15] = ['D#5', 3];
  drums[30] = ['A-4', 9];
  drums[31] = ['A-4', 11];

  [lead, arp, bass, drums].forEach((part, channel) => {
    for (const [row, entry] of Object.entries(part)) {
      const [name, volume] = typeof entry === 'string' ? [entry, null] : entry;
      song.cells[channel]![Number(row)] = { note: parseNote(name) ?? NOTE_OFF, volume };
    }
  });

  return song;
}
