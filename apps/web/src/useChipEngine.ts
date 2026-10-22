import { useEffect, useState } from 'react';
import { ChipEngine } from '@duty-cycle/engine';

export interface EngineHandle {
  engine: ChipEngine | null;
  /** AudioContext state; 'suspended' until the first click or key press. */
  audioState: AudioContextState | 'loading';
  error: string | null;
}

/**
 * Creates the engine on mount. Browsers only let audio start inside a user
 * gesture, so the context is resumed on the first pointer or key press.
 */
export function useChipEngine(): EngineHandle {
  const [engine, setEngine] = useState<ChipEngine | null>(null);
  const [audioState, setAudioState] = useState<EngineHandle['audioState']>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: ChipEngine | null = null;

    ChipEngine.create()
      .then((next) => {
        if (cancelled) {
          void next.close();
          return;
        }
        created = next;
        const sync = () => setAudioState(next.context.state);
        next.context.addEventListener('statechange', sync);
        sync();
        setEngine(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      void created?.close();
    };
  }, []);

  useEffect(() => {
    if (!engine) return;
    const resume = () => void engine.resume();
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
  }, [engine]);

  return { engine, audioState, error };
}

/** The row currently audible, polled once per animation frame while playing. */
export function usePlayhead(engine: ChipEngine | null, playing: boolean): number | null {
  const [row, setRow] = useState<number | null>(null);

  useEffect(() => {
    if (!engine || !playing) {
      setRow(null);
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      const next = engine.audibleRow();
      setRow((current) => (current === next ? current : next));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [engine, playing]);

  return row;
}
