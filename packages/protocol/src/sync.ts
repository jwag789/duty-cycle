import { applyOp, type Op } from './ops';
import type { Song } from './song';
import type { OpMessage, ServerOpMessage } from './wire';

export interface PendingOp {
  readonly clientSeq: number;
  readonly op: Op;
}

/**
 * A client's view of a shared song.
 *
 * `confirmed` is the song exactly as the server has ordered it, up to `seq`.
 * `pending` holds this client's own ops that the server hasn't echoed back yet.
 * What the player sees is confirmed with pending replayed on top, so local
 * edits show up instantly. Because the server's order is the only order, every
 * client converges to the same song once its pending ops come back.
 */
export interface SyncState {
  readonly confirmed: Song;
  readonly seq: number;
  readonly pending: readonly PendingOp[];
  readonly nextClientSeq: number;
}

export function createSync(song: Song, seq: number): SyncState {
  return { confirmed: song, seq, pending: [], nextClientSeq: 0 };
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
  return { ...state, confirmed: applyOp(state.confirmed, message.op), seq: message.seq, pending };
}

/** The song as this client should display and play it. */
export function viewSong(state: SyncState): Song {
  return state.pending.reduce((song, entry) => applyOp(song, entry.op), state.confirmed);
}
