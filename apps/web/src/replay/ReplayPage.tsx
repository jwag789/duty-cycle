import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { encodeWav, HistoryRenderer } from '@duty-cycle/engine';
import {
  CHANNELS,
  DUTY_CYCLES,
  historySpan,
  parseHistory,
  replayFrame,
  replayStart,
  replayTo,
  type History,
  type ReplayCursor,
  type Transport,
} from '@duty-cycle/protocol';
import { Button } from '../components/Button';
import { PatternGrid } from '../components/PatternGrid';
import { Scope } from '../components/Scope';
import { useChipEngine, usePlayhead } from '../useChipEngine';
import { clockTime, describeEvent } from './describe';

const TICK_MS = 50;
const EXPORT_RATE = 44_100;
const EXPORT_CHUNK = EXPORT_RATE; // one second of audio per slice of work
const MAX_EXPORT_MS = 20 * 60_000;
const NO_CURSOR = { row: -1, channel: -1, column: 'note' as const };

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; history: History };

/**
 * Plays a jam back from its saved history, through the same sync code and
 * synth the players used, so it sounds the way it did. Seek anywhere; export
 * the whole thing as a WAV.
 */
export function ReplayPage({ room }: { room: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/rooms/${room}/history`)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "There's no saved jam with this code." : `The server said ${response.status}.`);
        const history = parseHistory(await response.json());
        if (!history) throw new Error('The saved history is unreadable.');
        if (!cancelled) setLoad({ state: 'ready', history });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [room]);

  return (
    <div className="app replay">
      <header className="topbar">
        <h1 className="logo">
          Duty<span>Cycle</span>
        </h1>
        <span className="replay-title">
          Replay of <code>{room}</code>
        </span>
        <a className="btn replay-back" href={`/r/${room}`}>
          ← Back to the jam
        </a>
      </header>
      {load.state === 'loading' && <p className="room-placeholder">Loading the jam…</p>}
      {load.state === 'error' && <p className="room-placeholder">{load.message}</p>}
      {load.state === 'ready' &&
        (load.history.events.length === 0 ? (
          <p className="room-placeholder">Nothing happened in this jam yet.</p>
        ) : (
          <Player history={load.history} />
        ))}
    </div>
  );
}

function Player({ history }: { history: History }) {
  const span = useMemo(() => historySpan(history)!, [history]);
  const duration = span.end - span.start;
  const { engine, audioState } = useChipEngine();

  const [position, setPosition] = useState(span.start);
  const [playing, setPlaying] = useState(false);
  const cursor = useRef<ReplayCursor>(replayStart(history));
  // History time = performance.now() + offset, while playing.
  const offset = useRef(0);

  const frame = useMemo(() => {
    cursor.current = replayTo(history, cursor.current, position);
    return replayFrame(cursor.current, position);
  }, [history, position]);

  const playRow = usePlayhead(engine, playing && frame.transport.playing);

  // Feed the engine: what's audible plus queued edits, and the transport.
  const fed = useRef<string>('');
  useEffect(() => {
    if (!engine) return;
    const key = `${cursor.current.next}:${frame.queue.length}`;
    if (key !== fed.current) {
      fed.current = key;
      engine.setSong(frame.audible, frame.queue);
    }
    engine.follow(playing ? frame.transport : { ...frame.transport, playing: false }, offset.current);
  }, [engine, frame, playing]);

  // Advance the clock while playing.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const now = performance.now() + offset.current;
      if (now >= span.end) {
        setPosition(span.end);
        setPlaying(false);
      } else setPosition(now);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, span.end]);

  const startAt = useCallback(
    (at: number) => {
      offset.current = at - performance.now();
      cursor.current = replayTo(history, cursor.current, at);
      const next = replayFrame(cursor.current, at);
      if (engine) {
        void engine.resume();
        engine.setSong(next.audible, next.queue);
        engine.restart(next.transport, offset.current);
      }
      setPosition(at);
      setPlaying(true);
    },
    [engine, history],
  );

  const togglePlay = () => {
    if (playing) setPlaying(false);
    else startAt(position >= span.end ? span.start : position);
  };

  const seek = (at: number) => {
    if (playing) startAt(at);
    else setPosition(at);
  };

  // Space plays and pauses, as in the tracker.
  const toggleRef = useRef(togglePlay);
  toggleRef.current = togglePlay;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const recent = useMemo(() => {
    const end = cursor.current.next;
    const lines: { key: string; time: number; text: string }[] = [];
    for (let i = Math.max(0, end - 6); i < end; i++) {
      const event = history.events[i]!;
      lines.push({ key: `${i}`, time: event.time, text: describeEvent(event, transportBefore(history, i)) });
    }
    return lines.reverse();
  }, [history, frame]);
  const players = useMemo(
    () => [...new Set(history.events.map((e) => e.by).filter((by): by is string => by !== null))],
    [history],
  );
  const edits = history.events.filter((e) => e.kind === 'op').length;

  return (
    <>
      <div className="replay-bar">
        <Button className={playing ? 'play is-playing' : 'play'} onClick={togglePlay} aria-pressed={playing}>
          <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
          {playing ? 'Pause' : 'Play'}
          <kbd>Space</kbd>
        </Button>
        <span className="replay-time">
          {clockTime(position - span.start)} / {clockTime(duration)}
        </span>
        <input
          className="replay-scrub"
          type="range"
          min={span.start}
          max={span.end}
          step={10}
          value={position}
          onChange={(event) => seek(Number(event.target.value))}
          onPointerUp={(event) => event.currentTarget.blur()}
          aria-label="Position in the jam"
        />
        <Scope analyser={engine?.analyser ?? null} />
        <WavExport history={history} from={span.start} to={span.end} />
      </div>
      <p className="replay-meta">
        {edits} edits by {players.join(', ') || 'nobody'} · {frame.transport.bpm} bpm
        {audioState === 'suspended' && ' · click anywhere to turn on sound'}
      </p>

      <main className="tracker replay-body">
        <div className="tracker-inner">
          <div className="channel-headers">
            <span className="row-number-spacer" aria-hidden="true" />
            {frame.song.channels.map((settings, channel) => (
              <div key={channel} className="channel-header replay-channel" data-channel={channel}>
                <span className="channel-name">{CHANNELS[channel]!.name}</span>
                <span className="replay-channel-settings">
                  {CHANNELS[channel]!.kind === 'pulse' && `${DUTY_CYCLES[settings.duty]! * 100}% · `}
                  {CHANNELS[channel]!.kind === 'noise' && `${settings.shortNoise ? 'metal' : 'hiss'} · `}
                  decay {settings.decay === 0 ? 'hold' : settings.decay}
                </span>
              </div>
            ))}
          </div>
          <PatternGrid
            song={frame.song}
            audible={frame.audible}
            cursor={NO_CURSOR}
            playRow={playRow}
            mutes={NO_MUTES}
            peers={[]}
            onSelect={ignore}
          />
        </div>
        <aside className="replay-feed" aria-label="What happened">
          <h2>What happened</h2>
          {recent.length === 0 ? (
            <p className="replay-feed-empty">Nothing yet. Press play.</p>
          ) : (
            <ol>
              {recent.map((line) => (
                <li key={line.key}>
                  <time>{clockTime(line.time - span.start)}</time> {line.text}
                </li>
              ))}
            </ol>
          )}
        </aside>
      </main>
    </>
  );
}

const NO_MUTES = CHANNELS.map(() => false);

/** The transport in effect just before event `index`. */
function transportBefore(history: History, index: number): Transport | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const event = history.events[i]!;
    if (event.kind === 'transport') return event.transport;
  }
  return undefined;
}
const ignore = () => {};

/** Renders the whole jam offline, in slices so the page stays responsive, and saves it. */
function WavExport({ history, from, to }: { history: History; from: number; to: number }) {
  const [progress, setProgress] = useState<number | null>(null);
  const tooLong = to - from > MAX_EXPORT_MS;

  const exportWav = async () => {
    const renderer = new HistoryRenderer(history, { sampleRate: EXPORT_RATE, from, to });
    const samples = new Float32Array(renderer.totalFrames);
    setProgress(0);
    while (!renderer.done) {
      renderer.renderInto(samples, EXPORT_CHUNK);
      setProgress(renderer.progress);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const url = URL.createObjectURL(new Blob([encodeWav(samples, EXPORT_RATE)], { type: 'audio/wav' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `duty-cycle-${history.room}.wav`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setProgress(null);
  };

  return (
    <Button
      className="session-cta"
      disabled={progress !== null || tooLong}
      onClick={() => void exportWav()}
      title={tooLong ? 'Jams over 20 minutes are too long to export in the browser' : undefined}
    >
      {progress === null ? 'Download WAV' : `Rendering… ${Math.round(progress * 100)}%`}
    </Button>
  );
}
