import { describe, expect, it } from 'vitest';
import { clockTime, describeEvent } from './describe';

describe('replay feed', () => {
  it('describes edits and transport changes in words', () => {
    expect(describeEvent({ kind: 'op', time: 0, seq: 1, op: { type: 'setNote', channel: 1, row: 11, note: 72 }, at: null, by: 'Tiny Owl' })).toBe(
      'Tiny Owl put C-5 on Pulse 2 row 0B',
    );
    expect(describeEvent({ kind: 'op', time: 0, seq: 1, op: { type: 'setChannel', channel: 0, settings: { duty: 3 } }, at: null, by: 'Ada' })).toBe(
      'Ada set Pulse 1 to 75% duty',
    );
    const transport = { playing: true, epoch: 1, anchorTime: 0, anchorRow: 0, bpm: 140, rowsPerBeat: 4 };
    expect(describeEvent({ kind: 'transport', time: 0, transport, by: 'Ben' })).toBe('Ben pressed play at 140 bpm');
    // Same epoch as what was already playing: a tempo change, not a start.
    expect(describeEvent({ kind: 'transport', time: 0, transport: { ...transport, bpm: 160, anchorRow: 37 }, by: 'Ben' }, transport)).toBe(
      'Tempo switches to 160 bpm on row 25',
    );
    expect(describeEvent({ kind: 'transport', time: 0, transport: { ...transport, playing: false }, by: null })).toBe(
      'The server stopped playback',
    );
  });

  it('formats times as m:ss', () => {
    expect(clockTime(0)).toBe('0:00');
    expect(clockTime(61_900)).toBe('1:01');
    expect(clockTime(-5)).toBe('0:00');
  });
});
