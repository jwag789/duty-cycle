# Duty Cycle

A chiptune tracker for jamming together in the browser. Everyone in a room hears the same song, sample for sample, on the same beat.

> **Status: M0.** A complete single-player tracker with an NES-style synth. Multiplayer starts in M1. See the [roadmap](#roadmap).

## Why this is hard

Playing music together over the internet is a famously unsolved problem: network lag (50–150 ms) is longer than the timing error musicians can hear (~10–20 ms). Streaming audio between players can't fix that.

A tracker gets around it, because you aren't streaming a performance. You're editing a score that loops:

- **No audio crosses the network.** Every browser runs the same deterministic synth on the same song data, on a clock synced to the server. Lag only changes when an edit arrives, never the timing of the playback.
- **Edits are scheduled into the future.** The server stamps each edit with a step that's safely ahead for every player, so it starts on the same beat everywhere.

M0 builds the half of that you can't fake later: a synth and sequencer that are **sample-accurate and deterministic**, and that run on the audio thread.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 43 tests: protocol, DSP and timing, editor
npm run typecheck
npm run build
```

Click anywhere or press a key to turn sound on (browsers block audio until you interact with the page), then press **Space**.

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
  protocol/   Song model, edit ops (Zod), note names, timing math, demo song
              "@duty-cycle/protocol/core" is the Zod-free half the audio thread imports
  engine/     ChipSynth + Sequencer (pure TS), the AudioWorklet, the main-thread ChipEngine
apps/
  web/        Vite + React tracker UI
```

**Song and ops.** A song is four channels × N rows of `{ note, volume }` cells plus per-channel settings. Every change is an `Op` (`setNote`, `setVolume`, `clearCell`, `setBpm`, `setChannel`) applied by a pure `applyOp` function. In M0 the editor produces ops locally. In M1 the same ops go over the wire, the server puts them in one order, and every client runs the same `applyOp`.

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

## Roadmap

| | Milestone | Done when |
|---|---|---|
| ✅ | **M0: Single-player tracker** | AudioWorklet chip synth, 32-row pattern, tracker keyboard entry, play/stop, BPM |
| | **M1: Rooms** | Share a link and others join. Edits are server-ordered and shown immediately; a joining player gets a snapshot; colored cursors show where everyone is |
| | **M2: Synced transport** | NTP-style clock sync; every player's playhead is on the same step; a debug overlay shows clock offset and round-trip time |
| | **M3: Edits land on the same beat** | Edits scheduled into the future; two headless clients with simulated lag and jitter produce identical audio event logs |
| | **M4: Persistence and replay** | The edit log in Postgres; `/replay` page; WAV export |

Planned for after v1: live keyboard playing (each note quantized to the next beat everyone can reach), multi-pattern songs, an effects column, multiplayer undo, mobile.
