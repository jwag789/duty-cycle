# Duty Cycle

A chiptune tracker for jamming together in the browser. Everyone in a room hears the same song, sample for sample, on the same beat.

> **Status: M3.** Share a link, edit the same song together, and press Play. Everyone hears the same row at the same moment, and every edit and tempo change lands on the same row for everyone. In simulation, players on very different networks produce bit-identical audio. Persistence and replay are next (M4). See the [roadmap](#roadmap).

## Why this is hard

Playing music together over the internet is a famously unsolved problem: network lag (50–150 ms) is longer than the timing error musicians can hear (~10–20 ms). Streaming audio between players can't fix that.

A tracker gets around it, because you aren't streaming a performance. You're editing a score that loops:

- **No audio crosses the network.** Every browser runs the same deterministic synth on the same song data, on a clock synced to the server. Lag only changes when an edit arrives, never the timing of the playback.
- **Edits are scheduled into the future.** The server stamps each edit with a step that's safely ahead for every player, so it starts on the same beat everywhere.

The pieces so far:

- **M0:** a synth and sequencer that are **sample-accurate and deterministic**, and run on the audio thread.
- **M1:** the shared song: one server-ordered stream of edits that every client converges on.
- **M2:** a shared clock and transport, so every player's audio hits the same row at the same moment.
- **M3:** edits scheduled onto a future row, so a change made by anyone starts on the same row for everyone.

## Run it

```bash
npm install
npm run dev        # room server on :8787 + web app on http://localhost:5173
npm test           # 93 tests: protocol, sync convergence, clock sync, same-beat edits, DSP and timing, server, editor
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
4. Press **Play**. It starts for everyone, on the same row, at the same moment. Press <kbd>`</kbd> to see the sync numbers: round trip, clock error bound, audio latency.
5. Edit while it plays. Your change shows up right away, dimmed with a dotted underline, then becomes audible a row or two later, on the same row for everyone.

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

**Shared clock** ([`clock.ts`](packages/protocol/src/clock.ts)). Each client pings the server NTP-style: 6 quick pings on connect, then one every 2 s. Each ping gives an offset estimate, `server − (sent + received) / 2`, that can be off by at most half its round trip. The client keeps the last 16 and trusts the one with the shortest round trip, because that's the one with the least room for error. Pings also report each player's best round trip to the server.

**Shared transport** ([`transport.ts`](packages/protocol/src/transport.ts), [`room.ts`](apps/server/src/room.ts)). The server owns a single answer to "which row is playing at server time T": row `anchorRow` at `anchorTime`, at the given tempo.

- **Play** is a request. The server sets row 0's time far enough ahead that the slowest player hears about it first: half the worst reported round trip plus 120 ms, kept between 150 ms and 1.5 s.
- **A tempo change during playback** doesn't jump. The server picks the first row boundary past that same lead time and anchors the new tempo there, at the moment the old tempo would have reached it.
- **Late joiners** get the running transport with their snapshot and fall in at the next row.

**From server time to the speaker** ([`engine.ts`](packages/engine/src/engine.ts), [`sequencer.ts`](packages/engine/src/sequencer.ts)). `getOutputTimestamp()` pairs the audio clock with `performance.now()` *at the speaker*, so output latency is accounted for. Each row is scheduled to be **heard** at its time, not merely rendered.

- The mapping is rechecked every 500 ms and corrected when it moves by more than 2 ms. That covers clock drift between the sound card and the CPU, and a better clock estimate arriving.
- The audio-thread sequencer treats new timing three ways:
  - a late start joins at the next row instead of rushing through the missed ones
  - a small correction never replays or skips a row
  - a tempo change anchored on a future row waits for that row, so everyone switches together

**Edits on the beat** ([`sync.ts`](packages/protocol/src/sync.ts), [`room.ts`](apps/server/src/room.ts), [`sequencer.ts`](packages/engine/src/sequencer.ts)).

- **Stamping:** during playback the server stamps every edit with the row it lands on. That's the first row at least one lead time ahead, and never earlier than the previous edit's row, so row order matches edit order.
- **Three layers per player:** what's *audible*, ordered edits *scheduled* for a later row, and the player's own *pending* edits. The editor shows all three, and edits that aren't audible yet are marked.
- **The audio thread** gets the audible song plus the queue and applies each edit just before its row plays, whenever the message arrived. So two players who got the same edit at different moments, both before its row, play the same samples.
- **Tempo:** a BPM edit lands on the same row as the tempo switch, so the number on screen and the tempo you hear change together.
- **Stops and restarts:** each Play starts a new *epoch*. Stopping or restarting lands everything still waiting, since those rows will never play.
- **Late joiners and reconnects** get both what's audible and what's still due.
- **The server** keeps the same sync state as a client, minus pending edits.

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

**Proving the timing** ([`transport.test.ts`](packages/protocol/src/transport.test.ts)):

- A simulated network runs the real clock estimator for two players. Their clocks are off by −83 s and +86 min; one has 12 ms of latency each way, the other 95 ms, with random jitter on both. They schedule the same row within 10 ms of each other.
- A property test over 300 random networks checks that the clock error never exceeds half the best round trip.
- Another test pins down the case this can't solve. A lopsided route (100 ms up, 20 ms down) puts that player 40 ms early. NTP has the same blind spot, and so does every scheme that can't see one-way delays.
- Sequencer tests cover a future start, a late start, a tempo switch landing exactly on its row, and corrections in both directions.
- Server tests check the lead time, the tempo-change anchor, late joiners, and stopping when the room empties.

**Measured in the browser**: two tabs in one jam, reading the moment each one actually *hears* a row:

- They heard the same row **0.14 ms** apart, and within 0.4 ms of the server's schedule.
- After a 140 → 175 BPM change mid-playback, they were still **0.15 ms** apart.

Same-machine clocks make this the easy case. Across a real network, the clock error bound in the <kbd>`</kbd> panel is the number that matters.

**Proving the edits land together** ([`beat.test.ts`](apps/server/src/beat.test.ts)). This is M3's claim end to end. A real `Room` runs on a simulated network in 1 ms steps:

- Two players connect, one 8 ms away and one 140–160 ms away on 60 ms of jitter.
- They make 40 edits during playback, plus a tempo change and a duty-cycle change.
- Each player feeds the real sequencer and synth exactly what the app feeds its audio thread, and renders 9 s of 48 kHz audio.
- **The two renders are bit-identical.** The same holds for 5 random 3-player networks.
- The negative control is a player whose real delay is far longer than it reports. It receives edits after their rows started, and its audio diverges.
- Removing the server's lead time breaks every one of these tests.

Engine tests ([`engine.test.ts`](packages/engine/src/engine.test.ts)) prove the same at the sample level for one edit. Whether it reaches the audio thread at frame 10 or at frame 47999, the output is identical to swapping in the edited song exactly on row 8. One frame late, it isn't.

**In the browser:** two tabs received the same edit queued for the same row, about 250 ms before that row played.

## Roadmap

| | Milestone | Done when |
|---|---|---|
| ✅ | **M0: Single-player tracker** | AudioWorklet chip synth, 32-row pattern, tracker keyboard entry, play/stop, BPM |
| ✅ | **M1: Rooms** | Share a link and others join. Edits are server-ordered and shown immediately; a joining player gets a snapshot; colored cursors show where everyone is |
| ✅ | **M2: Synced transport** | NTP-style clock sync; every player's playhead is on the same step; a debug overlay shows clock offset and round-trip time |
| ✅ | **M3: Edits land on the same beat** | Edits scheduled onto a future row; players on simulated networks with very different lag and jitter render bit-identical audio |
| | **M4: Persistence and replay** | The edit log in Postgres; `/replay` page; WAV export |

Planned for after v1: live keyboard playing (each note quantized to the next beat everyone can reach), multi-pattern songs, an effects column, multiplayer undo, mobile.
