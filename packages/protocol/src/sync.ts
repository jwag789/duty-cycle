import { applyOp } from './apply';
import type { Op } from './ops';
import type { Song } from './song';
import type { Transport } from './transport';
import type { OpMessage, ScheduledOp, ServerOpMessage } from './wire';

export interface PendingOp {
  readonly clientSeq: number;
  readonly op: Op;
}

/**
 * A client's view of a shared song, in three layers:
 *
 * - `audible`: the song as everyone is hearing it right now.
 * - `scheduled`: edits the server has ordered but that wait for their row.
 *   During playback the server stamps each edit with a row far enough ahead
 *   that every player has it before that row plays, so everyone hears it
 *   start on the same row.
 * - `pending`: this client's own edits the server hasn't echoed back yet.
 *
 * `confirmedSong` is audible plus scheduled: the server's song. `viewSong`
 * adds pending on top: what the editor shows, so your own edits appear at once.
 * Because the server's order is the only order, every client converges.
 */
export interface SyncState {
  readonly audible: Song;
  /** In server order, which is also row order within an epoch. */
  readonly scheduled: readonly ScheduledOp[];
  readonly seq: number;
  readonly pending: readonly PendingOp[];
  readonly nextClientSeq: number;
}

export function createSync(song: Song, seq: number, scheduled: readonly ScheduledOp[] = []): SyncState {
  return { audible: song, scheduled, seq, pending: [], nextClientSeq: 0 };
}

/** Records a local edit and returns the message to send for it. */
export function applyLocal(state: SyncState, op: Op): { state: SyncState; message: OpMessage } {
  const clientSeq = state.nextClientSeq;
  return {
    state: { ...state, pending: [...state.pending, { clientSeq, op }], nextClientSeq: clientSeq + 1 },
    message: { type: 'op', clientSeq, op },
  };
}

/**
 * Applies the server's next op. Returns null if the op isn't the next one in
 * sequence: something was missed, and the caller should fetch a fresh snapshot.
 */
export function applyRemote(state: SyncState, message: ServerOpMessage, me: string): SyncState | null {
  if (message.seq !== state.seq + 1) return null;
  const pending =
    message.from === me ? state.pending.filter((entry) => entry.clientSeq !== message.clientSeq) : state.pending;

  if (message.at) {
    return { ...state, scheduled: [...state.scheduled, { ...message.at, op: message.op }], seq: message.seq, pending };
  }
  // Applies now. Anything still scheduled was ordered before it, so it goes first.
  const audible = applyOp(confirmedSong(state), message.op);
  return { ...state, audible, scheduled: [], seq: message.seq, pending };
}

/**
 * Moves scheduled edits into the audible song once their row has started.
 * Edits from an earlier epoch, or anything at all once stopped, land at once:
 * their rows will never play. `row` is the absolute row now playing, or null.
 */
export function settle(state: SyncState, transport: Transport, row: number | null): SyncState {
  let landed = 0;
  for (const entry of state.scheduled) {
    const due = !transport.playing || entry.epoch !== transport.epoch || (row !== null && entry.row <= row);
    if (!due) break;
    landed++;
  }
  if (landed === 0) return state;
  const audible = state.scheduled.slice(0, landed).reduce((song, entry) => applyOp(song, entry.op), state.audible);
  return { ...state, audible, scheduled: state.scheduled.slice(landed) };
}

/** The song as the server has it: audible plus everything scheduled. */
export function confirmedSong(state: SyncState): Song {
  return state.scheduled.reduce((song, entry) => applyOp(song, entry.op), state.audible);
}

/** The song as this client should display it. */
export function viewSong(state: SyncState): Song {
  return state.pending.reduce((song, entry) => applyOp(song, entry.op), confirmedSong(state));
}
