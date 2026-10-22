import { useCallback, useEffect, useRef, useState } from 'react';
import { applyOp, CHANNELS, demoSong, emptySong, type ChannelSettings, type Op } from '@duty-cycle/protocol';
import { ChannelHeader } from './components/ChannelHeader';
import { Button } from './components/Button';
import { PatternGrid } from './components/PatternGrid';
import { Scope } from './components/Scope';
import { Transport } from './components/Transport';
import { handleKey, INITIAL_EDITOR, type Cursor, type EditorState } from './editor';
import { loadSong, saveSong } from './storage';
import { useChipEngine, usePlayhead } from './useChipEngine';

export function App() {
  const [song, setSong] = useState(loadSong);
  const [editor, setEditor] = useState<EditorState>(INITIAL_EDITOR);
  const [mutes, setMutes] = useState<boolean[]>(() => CHANNELS.map(() => false));
  const [playing, setPlaying] = useState(false);
  const { engine, audioState, error } = useChipEngine();
  const playRow = usePlayhead(engine, playing);

  const dispatch = useCallback((ops: Op[]) => {
    if (ops.length > 0) setSong((current) => ops.reduce(applyOp, current));
  }, []);

  useEffect(() => {
    engine?.setSong(song);
    saveSong(song);
  }, [engine, song]);

  useEffect(() => {
    engine?.setMutes(mutes);
  }, [engine, mutes]);

  const togglePlay = useCallback(() => {
    if (!engine) return;
    void engine.resume();
    if (playing) engine.stop();
    else engine.play(0);
    setPlaying(!playing);
  }, [engine, playing]);

  // The key handler reads the latest state through refs so it is bound once.
  const latest = useRef({ editor, song, engine, togglePlay });
  latest.current = { editor, song, engine, togglePlay };
  const heldPreviews = useRef(new Map<string, number>());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
      const { editor, song, engine, togglePlay } = latest.current;
      const result = handleKey(editor, song, {
        code: event.code,
        key: event.key,
        shift: event.shiftKey,
        repeat: event.repeat,
      });
      if (!result.handled) return;
      event.preventDefault();
      setEditor(result.state);
      dispatch(result.ops);
      if (result.preview && engine) {
        const { channel, note, volume } = result.preview;
        engine.preview(channel, note, volume);
        heldPreviews.current.set(event.code, channel);
      }
      if (result.togglePlay) togglePlay();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const channel = heldPreviews.current.get(event.code);
      if (channel === undefined) return;
      heldPreviews.current.delete(event.code);
      latest.current.engine?.release(channel);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [dispatch]);

  const select = useCallback((cursor: Cursor) => setEditor((state) => ({ ...state, cursor })), []);

  const setChannel = (channel: number, settings: Partial<ChannelSettings>) =>
    dispatch([{ type: 'setChannel', channel, settings }]);

  const toggleMute = (channel: number) =>
    setMutes((current) => current.map((muted, i) => (i === channel ? !muted : muted)));

  const replaceSong = (next: typeof song) => {
    setSong(next);
    setEditor((state) => ({ ...state, cursor: INITIAL_EDITOR.cursor }));
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">
          Duty<span>Cycle</span>
        </h1>
        <Transport
          playing={playing}
          bpm={song.bpm}
          octave={editor.octave}
          step={editor.step}
          onTogglePlay={togglePlay}
          onBpm={(bpm) => dispatch([{ type: 'setBpm', bpm }])}
          onOctave={(octave) => setEditor((state) => ({ ...state, octave }))}
          onStep={(step) => setEditor((state) => ({ ...state, step }))}
        />
        <Scope analyser={engine?.analyser ?? null} />
        <div className="song-actions">
          <Button onClick={() => replaceSong(demoSong())}>Load demo</Button>
          <Button onClick={() => replaceSong(emptySong({ bpm: song.bpm }))}>Clear</Button>
        </div>
      </header>

      {error ? (
        <p className="notice is-error" role="alert">
          Audio couldn't start: {error}
        </p>
      ) : audioState === 'suspended' ? (
        <p className="notice">Click anywhere or press a key to turn on sound.</p>
      ) : null}

      <main className="tracker">
        <div className="tracker-inner">
          <div className="channel-headers">
            <span className="row-number-spacer" aria-hidden="true" />
            {song.channels.map((settings, channel) => (
              <ChannelHeader
                key={channel}
                channel={channel}
                settings={settings}
                muted={mutes[channel]!}
                onMute={() => toggleMute(channel)}
                onChange={(patch) => setChannel(channel, patch)}
              />
            ))}
          </div>
          <PatternGrid song={song} cursor={editor.cursor} playRow={playRow} mutes={mutes} onSelect={select} />
        </div>
      </main>

      <footer className="keys">
        <span>
          <kbd>Z</kbd>–<kbd>M</kbd> / <kbd>Q</kbd>–<kbd>P</kbd> notes
        </span>
        <span>
          <kbd>1</kbd> note off
        </span>
        <span>
          <kbd>0</kbd>–<kbd>F</kbd> volume
        </span>
        <span>
          <kbd>Del</kbd> clear
        </span>
        <span>
          <kbd>←↑↓→</kbd> <kbd>Tab</kbd> move
        </span>
        <span>
          <kbd>Space</kbd> play / stop
        </span>
      </footer>
    </div>
  );
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type);
}
