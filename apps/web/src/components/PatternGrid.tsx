import { memo, useEffect, useRef, type Ref } from 'react';
import { CHANNELS, noteName, type Cell, type Song } from '@duty-cycle/protocol';
import type { Column, Cursor } from '../editor';

interface PatternGridProps {
  song: Song;
  cursor: Cursor;
  playRow: number | null;
  mutes: boolean[];
  onSelect: (cursor: Cursor) => void;
}

export function PatternGrid({ song, cursor, playRow, mutes, onSelect }: PatternGridProps) {
  const cursorRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursorRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor.row]);

  const barRows = song.rowsPerBeat * 4;

  return (
    <div className="grid" role="grid" aria-label="Pattern" aria-rowcount={song.rows}>
      {Array.from({ length: song.rows }, (_, row) => (
        <Row
          key={row}
          ref={row === cursor.row ? cursorRowRef : undefined}
          row={row}
          cells={song.cells.map((column) => column[row]!)}
          beat={row % song.rowsPerBeat === 0}
          bar={row % barRows === 0}
          playing={row === playRow}
          cursor={row === cursor.row ? cursor : null}
          mutes={mutes}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface RowProps {
  ref?: Ref<HTMLDivElement>;
  row: number;
  cells: Cell[];
  beat: boolean;
  bar: boolean;
  playing: boolean;
  cursor: Cursor | null;
  mutes: boolean[];
  onSelect: (cursor: Cursor) => void;
}

const Row = memo(
  function Row({ ref, row, cells, beat, bar, playing, cursor, mutes, onSelect }: RowProps) {
    const classes = ['grid-row'];
    if (beat) classes.push('is-beat');
    if (bar) classes.push('is-bar');
    if (playing) classes.push('is-playing');
    if (cursor) classes.push('is-cursor-row');

    return (
      <div ref={ref} className={classes.join(' ')} role="row" aria-rowindex={row + 1}>
        <span className="row-number" role="rowheader">
          {row.toString(16).toUpperCase().padStart(2, '0')}
        </span>
        {cells.map((cell, channel) => (
          <div
            key={channel}
            className={mutes[channel] ? 'cell is-muted' : 'cell'}
            data-channel={channel}
            role="gridcell"
            aria-label={`${CHANNELS[channel]!.name}, row ${row}: ${describe(cell)}`}
          >
            <CellPart
              column="note"
              text={cell.note === null ? '---' : noteName(cell.note)}
              empty={cell.note === null}
              active={cursor?.channel === channel && cursor.column === 'note'}
              onSelect={() => onSelect({ row, channel, column: 'note' })}
            />
            <CellPart
              column="volume"
              text={cell.volume === null ? '·' : cell.volume.toString(16).toUpperCase()}
              empty={cell.volume === null}
              active={cursor?.channel === channel && cursor.column === 'volume'}
              onSelect={() => onSelect({ row, channel, column: 'volume' })}
            />
          </div>
        ))}
      </div>
    );
  },
  (prev, next) =>
    prev.cells.every((cell, i) => cell === next.cells[i]) &&
    prev.beat === next.beat &&
    prev.bar === next.bar &&
    prev.playing === next.playing &&
    prev.cursor?.channel === next.cursor?.channel &&
    prev.cursor?.column === next.cursor?.column &&
    prev.mutes === next.mutes &&
    prev.ref === next.ref &&
    prev.onSelect === next.onSelect,
);

interface CellPartProps {
  column: Column;
  text: string;
  empty: boolean;
  active: boolean;
  onSelect: () => void;
}

function CellPart({ column, text, empty, active, onSelect }: CellPartProps) {
  const classes = [column === 'note' ? 'cell-note' : 'cell-volume'];
  if (empty) classes.push('is-empty');
  if (text === '===') classes.push('is-off');
  if (active) classes.push('is-caret');
  return (
    <span className={classes.join(' ')} onMouseDown={onSelect}>
      {text}
    </span>
  );
}

function describe(cell: Cell): string {
  if (cell.note === null && cell.volume === null) return 'empty';
  const parts: string[] = [];
  if (cell.note !== null) parts.push(noteName(cell.note) === '===' ? 'note off' : noteName(cell.note));
  if (cell.volume !== null) parts.push(`volume ${cell.volume}`);
  return parts.join(', ');
}
