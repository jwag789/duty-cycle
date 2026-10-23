import {
  applyRemote,
  createSync,
  framesPerRow,
  settle,
  STOPPED,
  type History,
  type HistoryEvent,
  type SyncState,
  type Transport,
} from '@duty-cycle/protocol';
import { Sequencer, type QueuedOp } from './sequencer';
import { ChipSynth } from './synth';

export interface HistoryRenderOptions {
  sampleRate: number;
  /** Server time (ms) of the first frame. */
  from: number;
  /** Server time (ms) to stop at. */
  to: number;
}

/**
 * Plays a room's history through the same sync code, sequencer and synth the
 * players ran, with every event applied at the server time it happened. Since
 * everyone got each event before it mattered, this is what they heard.
 *
 * Renders in chunks, so a page can show progress and stay responsive.
 */
export class HistoryRenderer {
  readonly totalFrames: number;
  private readonly sequencer: Sequencer;
  private readonly framesPerMs: number;
  private sync: SyncState;
  private transport: Transport = STOPPED;
  private nextEvent = 0;
  private frame = 0;

  constructor(
    private readonly history: History,
    private readonly options: HistoryRenderOptions,
  ) {
    this.framesPerMs = options.sampleRate / 1000;
    this.totalFrames = Math.max(0, Math.ceil((options.to - options.from) * this.framesPerMs));
    this.sync = createSync(history.seed, 0);
    this.sequencer = new Sequencer(new ChipSynth(options.sampleRate, history.seed.channels), history.seed);
  }

  get done(): boolean {
    return this.frame >= this.totalFrames;
  }

  get progress(): number {
    return this.totalFrames === 0 ? 1 : this.frame / this.totalFrames;
  }

  /** Renders up to `frames` more frames into `out`, starting where it left off. Returns how many. */
  renderInto(out: Float32Array, frames: number): number {
    const end = Math.min(this.totalFrames, this.frame + frames);
    const start = this.frame;
    for (let f = start; f < end; f++) {
      while (this.nextEvent < this.history.events.length && this.frameOf(this.history.events[this.nextEvent]!.time) <= f) {
        this.apply(this.history.events[this.nextEvent]!, f);
        this.nextEvent++;
      }
      out[f] = this.sequencer.tick(f);
    }
    this.frame = end;
    return end - start;
  }

  private frameOf(time: number): number {
    return Math.ceil((time - this.options.from) * this.framesPerMs);
  }

  private apply(event: HistoryEvent, frame: number): void {
    if (event.kind === 'op') {
      this.sync = applyRemote(
        this.sync,
        { type: 'op', seq: this.sync.seq + 1, op: event.op, from: '', clientSeq: 0, at: event.at },
        'render',
      )!;
    } else {
      const t = event.transport;
      this.transport = t;
      this.sync = settle(this.sync, t, null);
      this.sequencer.setTiming(
        t.playing
          ? {
              anchorFrame: (t.anchorTime - this.options.from) * this.framesPerMs,
              anchorRow: t.anchorRow,
              framesPerRow: framesPerRow(this.options.sampleRate, t.bpm, t.rowsPerBeat),
            }
          : null,
        frame,
      );
    }
    const queue: QueuedOp[] = this.sync.scheduled
      .filter((entry) => entry.epoch === this.transport.epoch)
      .map(({ row, op }) => ({ row, op }));
    this.sequencer.setSong(this.sync.audible, queue);
  }
}

/** Renders a whole history in one go. */
export function renderHistory(history: History, options: HistoryRenderOptions): Float32Array {
  const renderer = new HistoryRenderer(history, options);
  const out = new Float32Array(renderer.totalFrames);
  renderer.renderInto(out, renderer.totalFrames);
  return out;
}
