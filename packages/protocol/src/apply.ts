import { EMPTY_CELL } from './factory';
import type { Op } from './ops';
import type { Cell, ChannelSettings, Song } from './song';

/**
 * Applies one op and returns a new song, sharing every untouched column.
 * Ops that point outside the song are ignored rather than thrown, because a
 * remote op can legitimately race a change to the song's size.
 */
export function applyOp(song: Song, op: Op): Song {
  switch (op.type) {
    case 'setNote':
      return updateCell(song, op.channel, op.row, { note: op.note });
    case 'setVolume':
      return updateCell(song, op.channel, op.row, { volume: op.volume });
    case 'clearCell':
      return updateCell(song, op.channel, op.row, EMPTY_CELL);
    case 'setBpm':
      return song.bpm === op.bpm ? song : { ...song, bpm: op.bpm };
    case 'setChannel': {
      const current = song.channels[op.channel];
      if (!current) return song;
      const patch = definedOnly(op.settings);
      const channels = song.channels.slice();
      channels[op.channel] = { ...current, ...patch };
      return { ...song, channels };
    }
    case 'replaceSong':
      return op.song;
  }
}

function updateCell(song: Song, channel: number, row: number, patch: Partial<Cell>): Song {
  const column = song.cells[channel];
  const cell = column?.[row];
  if (!column || !cell) return song;
  const nextColumn = column.slice();
  nextColumn[row] = { ...cell, ...patch };
  const cells = song.cells.slice();
  cells[channel] = nextColumn;
  return { ...song, cells };
}

function definedOnly(settings: Partial<ChannelSettings>): Partial<ChannelSettings> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}
