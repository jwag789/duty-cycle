import { CHANNELS, DUTY_CYCLES, noteName, type HistoryEvent, type Transport } from '@duty-cycle/protocol';

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * One line for the replay's event feed. `previous` is the transport before
 * this event: a playing transport in the same epoch is a tempo switch, not a start.
 */
export function describeEvent(event: HistoryEvent, previous?: Transport): string {
  if (event.kind === 'transport') {
    const { transport } = event;
    const who = event.by ?? 'The server';
    if (!transport.playing) return `${who} stopped playback`;
    if (previous?.playing && previous.epoch === transport.epoch) {
      return `Tempo switches to ${transport.bpm} bpm on row ${hex(transport.anchorRow % 256)}`;
    }
    return `${who} pressed play at ${transport.bpm} bpm`;
  }
  const { op, by } = event;
  switch (op.type) {
    case 'setNote':
      return op.note === null
        ? `${by} cleared ${CHANNELS[op.channel]!.name} row ${hex(op.row)}`
        : `${by} put ${noteName(op.note)} on ${CHANNELS[op.channel]!.name} row ${hex(op.row)}`;
    case 'setVolume':
      return `${by} set ${CHANNELS[op.channel]!.name} row ${hex(op.row)} volume to ${op.volume === null ? 'default' : op.volume.toString(16).toUpperCase()}`;
    case 'clearCell':
      return `${by} cleared ${CHANNELS[op.channel]!.name} row ${hex(op.row)}`;
    case 'setBpm':
      return `${by} changed the tempo to ${op.bpm} bpm`;
    case 'setChannel': {
      const name = CHANNELS[op.channel]!.name;
      if (op.settings.duty !== undefined) return `${by} set ${name} to ${DUTY_CYCLES[op.settings.duty]! * 100}% duty`;
      if (op.settings.decay !== undefined) return `${by} set ${name} decay to ${op.settings.decay}`;
      return `${by} switched ${name} to ${op.settings.shortNoise ? 'metal' : 'hiss'} noise`;
    }
    case 'replaceSong':
      return `${by} loaded a new song`;
  }
}

/** m:ss for a span of milliseconds. */
export function clockTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
