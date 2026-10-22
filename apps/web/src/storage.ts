import { demoSong, parseSong, type Song } from '@duty-cycle/protocol';

// Stand-in until M4 persists songs on the server: keeps your work across a refresh.
const KEY = 'duty-cycle:song:v1';

export function loadSong(): Song {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseSong(JSON.parse(raw)) ?? demoSong();
  } catch {
    // Storage blocked or corrupt; start from the demo.
  }
  return demoSong();
}

export function saveSong(song: Song): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(song));
  } catch {
    // Private mode or full storage: the song still lives in memory.
  }
}
