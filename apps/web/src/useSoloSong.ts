import { useCallback, useEffect, useState } from 'react';
import { applyOp, type Op } from '@duty-cycle/protocol';
import { loadSong, saveSong } from './storage';

/** The song when you're on your own: in memory, saved to this browser. */
export function useSoloSong() {
  const [song, setSong] = useState(loadSong);

  useEffect(() => saveSong(song), [song]);

  const dispatch = useCallback((ops: readonly Op[]) => {
    if (ops.length > 0) setSong((current) => ops.reduce(applyOp, current));
  }, []);

  return { song, dispatch };
}
