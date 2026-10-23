import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANNELS, demoSong, emptySong, type ChannelSettings, type Op, type Song } from '@duty-cycle/protocol';
import { ChannelHeader } from './components/ChannelHeader';
import { Button } from './components/Button';
import { PatternGrid } from './components/PatternGrid';
import { Scope } from './components/Scope';
import { SessionBar } from './components/SessionBar';
import { SyncPanel } from './components/SyncPanel';
import { Transport } from './components/Transport';
import { handleKey, INITIAL_EDITOR, type Cursor, type EditorState } from './editor';
import { newRoomId, roomFromPath, roomUrl } from './net/session';
import { useRoom } from './net/useRoom';
import { useChipEngine, usePlayhead } from './useChipEngine';
import { usePlayback } from './usePlayback';
import { useSoloSong } from './useSoloSong';

export function App() {
  const [room, setRoom] = useState(() => roomFromPath(location.pathname));
  // The song a new jam starts from; only the person who starts it sends one.
  const [jamSeed, setJamSeed] = useState<{ room: string; song: Song } | null>(null);
  const solo = useSoloSong();
  const { connection, snapshot } = useRoom(room, jamSeed?.room === room ? jamSeed.song : undefined);

  const song = room ? snapshot.song : solo.song;
  const dispatch = useCallback(
    (ops: readonly Op[]) => (connection ? connection.dispatch(ops) : solo.dispatch(ops)),
    [connection, solo.dispatch],
  );

  const [editor, setEditor] = useState<EditorState>(INITIAL_EDITOR);
  const [mutes, setMutes] = useState<boolean[]>(() => CHANNELS.map(() => false));
  const [showSync, setShowSync] = useState(false);
  const { engine, audioState, error } = useChipEngine();
  const playback = usePlayback(room, connection, snapshot, song);
  const playing = playback.transport.playing;
  const playRow = usePlayhead(engine, playing);

  // Dev-only handle for poking at timing from the console.
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __dutyCycle: { engine, transport: playback.transport } });
  }, [engine, playback.transport]);

  useEffect(() => {
    const onPopState = () => setRoom(roomFromPath(location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (song) engine?.setSong(song);
  }, [engine, song]);

  useEffect(() => {
    engine?.setMutes(mutes);
  }, [engine, mutes]);

  useEffect(() => {
    engine?.follow(playback.transport, playback.offset);
  }, [engine, playback.transport, playback.offset]);

  useEffect(() => {
    connection?.setCursor(editor.cursor);
  }, [connection, editor.cursor]);

  // Someone may load a shorter song under your cursor.
  useEffect(() => {
    if (song && editor.cursor.row >= song.rows) {
      setEditor((state) => ({ ...state, cursor: { ...state.cursor, row: song.rows - 1 } }));
    }
  }, [song, editor.cursor.row]);

  const { play, stop, ready } = playback;
  const togglePlay = useCallback(() => {
    if (!engine || !ready) return;
    void engine.resume();
    if (playing) stop();
    else play();
  }, [engine, ready, playing, play, stop]);

  // The key handler reads the latest state through a ref so it is bound once.
  const latest = useRef({ editor, song, engine, togglePlay, dispatch });
  latest.current = { editor, song, engine, togglePlay, dispatch };
  const heldPreviews = useRef(new Map<string, number>());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTextField(event.target)) return;
      if (event.code === 'Backquote') {
        event.preventDefault();
        setShowSync((shown) => !shown);
        return;
      }
      const { editor, song, engine, togglePlay, dispatch } = latest.current;
      if (!song) return;
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
  }, []);

  const select = useCallback((cursor: Cursor) => setEditor((state) => ({ ...state, cursor })), []);

  const goTo = (path: string, nextRoom: string | null) => {
    history.pushState(null, '', path);
    setRoom(nextRoom);
  };

  const startJam = () => {
    const id = newRoomId();
    setJamSeed({ room: id, song: solo.song });
    goTo(`/r/${id}`, id);
  };

  const replaceSong = (next: Song) => {
    dispatch([{ type: 'replaceSong', song: next }]);
    setEditor((state) => ({ ...state, cursor: INITIAL_EDITOR.cursor }));
  };

  const toggleMute = (channel: number) =>
    setMutes((current) => current.map((muted, i) => (i === channel ? !muted : muted)));

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">
          Duty<span>Cycle</span>
        </h1>
        <Transport
          playing={playing}
          ready={playback.ready}
          shared={room !== null}
          bpm={song?.bpm ?? 120}
          octave={editor.octave}
          step={editor.step}
          onTogglePlay={togglePlay}
          onBpm={(bpm) => dispatch([{ type: 'setBpm', bpm }])}
          onOctave={(octave) => setEditor((state) => ({ ...state, octave }))}
          onStep={(step) => setEditor((state) => ({ ...state, step }))}
        />
        <Scope analyser={engine?.analyser ?? null} />
        <div className="song-actions">
          <Button disabled={!song} onClick={() => replaceSong(demoSong())}>
            Load demo
          </Button>
          <Button disabled={!song} onClick={() => song && replaceSong(emptySong({ bpm: song.bpm }))}>
            Clear
          </Button>
        </div>
      </header>

      <SessionBar
        room={room}
        snapshot={snapshot}
        shareUrl={room ? roomUrl(room) : null}
        onStartJam={startJam}
        onLeave={() => goTo('/', null)}
      />

      {error ? (
        <p className="notice is-error" role="alert">
          Audio couldn't start: {error}
        </p>
      ) : audioState === 'suspended' ? (
        <p className="notice">Click anywhere or press a key to turn on sound.</p>
      ) : null}

      <main className="tracker">
        {song ? (
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
                  onChange={(patch: Partial<ChannelSettings>) => dispatch([{ type: 'setChannel', channel, settings: patch }])}
                />
              ))}
            </div>
            <PatternGrid
              song={song}
              cursor={editor.cursor}
              playRow={playRow}
              mutes={mutes}
              peers={room ? snapshot.peers : []}
              onSelect={select}
            />
          </div>
        ) : (
          <RoomPlaceholder status={snapshot.status} onLeave={() => goTo('/', null)} />
        )}
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
        <span>
          <kbd>`</kbd> sync stats
        </span>
      </footer>

      {showSync && (
        <SyncPanel
          engine={engine}
          inRoom={room !== null}
          clock={room ? snapshot.clock : null}
          transport={playback.transport}
          offset={playback.offset}
          onClose={() => setShowSync(false)}
        />
      )}
    </div>
  );
}

function RoomPlaceholder({ status, onLeave }: { status: string; onLeave: () => void }) {
  const message =
    status === 'full'
      ? 'This jam already has 8 players.'
      : status === 'failed'
        ? "Couldn't join this jam."
        : 'Joining the jam…';
  const stuck = status === 'full' || status === 'failed';
  return (
    <div className="room-placeholder">
      <p>{message}</p>
      {stuck && <Button onClick={onLeave}>Back to solo</Button>}
    </div>
  );
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && ['text', 'number', 'search'].includes(target.type);
}
