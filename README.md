# Duty Cycle

A chiptune tracker for jamming together in the browser. Everyone in a room hears the same song, sample for sample, on the same beat.

> **Status: M1.** Rooms work: share a link, edit the same song together and see each other's cursors. Each player still presses Play on their own clock; synced playback is M2. See the [roadmap](#roadmap).

## Why this is hard

Playing music together over the internet is a famously unsolved problem: network lag (50–150 ms) is longer than the timing error musicians can hear (~10–20 ms). Streaming audio between players can't fix that.

A tracker gets around it, because you aren't streaming a performance. You're editing a score that loops:

- **No audio crosses the network.** Every browser runs the same deterministic synth on the same song data, on a clock synced to the server. Lag only changes when an edit arrives, never the timing of the playback.
- **Edits are scheduled into the future.** The server stamps each edit with a step that's safely ahead for every player, so it starts on the same beat everywhere.

M0 built the half you can't fake later: a synth and sequencer that are **sample-accurate and deterministic**, and that run on the audio thread. M1 adds the shared song: one server-ordered stream of edits that every client converges on.

## Run it

```bash
npm install
npm run dev        # room server on :8787 + web app on http://localhost:5173
npm test           # 60 tests: protocol, sync convergence, DSP and timing, server, editor
npm run typecheck
npm run build && npm start   # production: the server serves the built app on :8787
```

Click anywhere or press a key to turn sound on (browsers block audio until you interact with the page), then press **Space**.

## Jamming with someone

1. Click **Start a jam →**. You get a room at `/r/<code>`, starting from whatever song you had open.
2. Click **Copy invite link** and open it somewhere else:
   - **Another tab or window.** Each tab is its own player with its own name.
   - **Another device on your Wi-Fi.** Run `npm run dev -w @duty-cycle/web -- --host` alongside the server (or `HOST=0.0.0.0 npm start` for the production build) and open the network URL it prints.
3. Edit away. Notes, volumes, BPM and channel settings sync for everyone, and you can see where each player's cursor is.

Rooms live in the server's memory until M4 adds Postgres. If the server restarts, the first player to reconnect restores the room from their copy.

## Keys

| Key | Action |
| --- | --- |
| `Z S X D C V G B H N J M` | Notes C to B in the current octave, laid out like a piano |
| `Q 2 W 3 E R 5 T 6 Y 7 U I 9 O 0 P` | The next octave and a bit |
| `1` | Note off |
| `0`–`F` (volume column) | Volume |
| `Del` / `Backspace` / `.` | Clear the column under the cursor |
| `← →` | Move between note and volume columns across channels |
| `↑ ↓` `PgUp` `PgDn` `Home` `End` | Move between rows |
| `Tab` / `Shift+Tab` | Next / previous channel |
| `[` `]` | Octave down / up |
| `-` `=` | Edit step down / up (rows the cursor moves after an entry) |
| `Space` | Play / stop |

Note keys use physical key positions, so the layout is the same on AZERTY or Dvorak.

## Architecture

```
packages/
  protocol/   Song model, edit ops and wire messages (Zod), client sync logic, note names, timing
              "@duty-cycle/protocol/core" is the Zod-free half the audio thread imports
  engine/     ChipSynth + Sequencer (pure TS), the AudioWorklet, the main-thread ChipEngine
  client/     RoomConnection: one room over a WebSocket, with optimistic edits and reconnects
apps/
  server/     Node + ws: rooms, edit ordering, presence, rate limits; serves the built web app
  web/        Vite + React tracker UI
```

**Song and ops.** A song is four channels × N rows of `{ note, volume }` cells plus per-channel settings. Every change is an `Op` (`setNote`, `setVolume`, `clearCell`, `setBpm`, `setChannel`, `replaceSong`) applied by a pure `applyOp` function. The client, the server and the tests all use the same `applyOp`. Every op *sets* a value rather than adjusting one, so applying an op twice is harmless.

**Shared editing** ([`sync.ts`](packages/protocol/src/sync.ts), [`room.ts`](apps/server/src/room.ts)). The server is the single source of order: each op it accepts gets the next sequence number and goes to everyone, its author included. A client keeps two things:

- `confirmed`: the song exactly as the server has ordered it
- `pending`: its own ops the server hasn't echoed back yet

What you see is `confirmed` with `pending` replayed on top. Your edits appear instantly, and when two people hit the same cell, everyone ends up with whichever edit the server ordered last. No CRDT is needed, because a server already decides the order. A gap in sequence numbers means a missed message: the client reconnects and starts again from a snapshot.

**Staying connected** ([`RoomConnection.ts`](packages/client/src/RoomConnection.ts)). On a drop it reconnects with exponential backoff and jitter. On reconnect it takes the server's snapshot and resends anything never confirmed, which is safe because ops can be applied twice. Its hello also offers the last confirmed song, so a restarted server gets the room back from the first player who returns.

**Server hygiene** ([`server.ts`](apps/server/src/server.ts)):

- every message is validated with Zod
- messages are capped at 256 KB
- each connection gets a token-bucket rate limit
- rooms hold at most 8 players
- empty rooms expire after 10 minutes
- dead connections are dropped by a heartbeat
- the first message must be a hello within 5 s

**Synth** ([`synth.ts`](packages/engine/src/synth.ts)). Modelled on the NES sound chip (the 2A03):

- Two pulse channels with four duty cycles, band-limited with PolyBLEP so high notes don't alias into mush
- The triangle's 32-step staircase, which is where its sound comes from
- A 15-bit LFSR noise channel with long (32767-step) and short (93-step, metallic) modes, clocked at the console's own timer periods
- Every amplitude change is ramped over about 2 ms, so notes never click
- A DC blocker and a gentle low-pass on the output

**Sequencer** ([`sequencer.ts`](packages/engine/src/sequencer.ts)). Each row starts on an exact frame. Row times are computed as `anchor + n × framesPerRow` rather than by adding up, so fractional row lengths never drift. Changing the tempo re-anchors on the last row that played.

**On the audio thread** ([`processor.ts`](packages/engine/src/processor.ts)). The sequencer runs inside an `AudioWorkletProcessor`, not on a main-thread timer. Timing doesn't depend on React renders or garbage collection, and it keeps playing when the tab is in the background. The bundle is about 5 KB.

**What you see matches what you hear** ([`engine.ts`](packages/engine/src/engine.ts)). The worklet renders ahead of the speakers. The playhead uses `getOutputTimestamp()` to show the row that is audible right now, not the row most recently processed.

**Proving it** ([`engine.test.ts`](packages/engine/src/engine.test.ts)). The synth and sequencer are plain TypeScript with no Web Audio dependency, so tests render real audio in Node. They check:

- rows land on exact frames, with no drift over 30 s at a tempo whose rows aren't a whole number of frames
- A-4 measures 440 Hz
- note off ramps down without a click
- both LFSR periods are correct
- the same song renders to identical samples every time

That last test is the foundation of M3.

**Proving the sync**:

- A property test ([`sync.test.ts`](packages/protocol/src/sync.test.ts)) uses fast-check. It runs a server and three clients through 500 random interleavings of edits and message deliveries, all fighting over the same few cells, and asserts that every client ends with the server's exact song. Breaking the sync logic makes it fail with a one-step counterexample.
- Integration tests ([`server.test.ts`](apps/server/src/server.test.ts), [`client.test.ts`](apps/server/src/client.test.ts)) run real `RoomConnection`s against the real server. They cover concurrent edits converging, edits made while offline arriving after a reconnect, a server restart restoring the room, cursors, full rooms, bad hellos and rate limiting.

## Roadmap

| | Milestone | Done when |
|---|---|---|
| ✅ | **M0: Single-player tracker** | AudioWorklet chip synth, 32-row pattern, tracker keyboard entry, play/stop, BPM |
| ✅ | **M1: Rooms** | Share a link and others join. Edits are server-ordered and shown immediately; a joining player gets a snapshot; colored cursors show where everyone is |
| | **M2: Synced transport** | NTP-style clock sync; every player's playhead is on the same step; a debug overlay shows clock offset and round-trip time |
| | **M3: Edits land on the same beat** | Edits scheduled into the future; two headless clients with simulated lag and jitter produce identical audio event logs |
| | **M4: Persistence and replay** | The edit log in Postgres; `/replay` page; WAV export |

Planned for after v1: live keyboard playing (each note quantized to the next beat everyone can reach), multi-pattern songs, an effects column, multiplayer undo, mobile.
