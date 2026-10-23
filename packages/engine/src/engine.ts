import { framesPerRow, timeOfRow, type Song, type Transport } from '@duty-cycle/protocol/core';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './messages';
import processorUrl from './processor.ts?worker&url';
import type { Timing } from './sequencer';

interface ScheduledRow {
  row: number;
  /** AudioContext time the row starts. */
  time: number;
}

export interface EngineStats {
  /** Time from the worklet rendering a sample to it leaving the speakers. */
  outputLatencyMs: number;
  /**
   * When the audio thread actually started each recent row, mapped to the
   * transport clock, minus when the schedule said it should start. Averaged and
   * measured through the same clock mapping that scheduled it, so this checks
   * the audio thread hit its targets. It doesn't compare two machines. Null
   * until a few rows have played.
   */
  scheduleErrorMs: number | null;
}

/** Re-check the clock mapping this often while playing. */
const RESYNC_MS = 500;
/** Ignore mapping jitter smaller than this rather than nudging the schedule. */
const RESYNC_THRESHOLD_MS = 2;
const ERROR_WINDOW = 16;

/**
 * Main-thread handle on the chip synth. Owns the AudioContext and the worklet
 * node. It follows a Transport: the shared "row N happens at time T" in some
 * reference clock (the server's in a jam, performance.now() when solo). It
 * maps that onto the audio clock so each row is *heard* at its time, then keeps
 * the mapping corrected as the clocks drift.
 */
export class ChipEngine {
  readonly analyser: AnalyserNode;
  private rows: ScheduledRow[] = [];
  private currentRow: number | null = null;
  private transport: Transport | null = null;
  /** Reference clock minus performance.now(), in ms. */
  private offset = 0;
  private sent: Timing | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private errors: number[] = [];
  private lastHeard: { absRow: number; perfTime: number } | null = null;

  private constructor(
    readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    const master = context.createGain();
    master.gain.value = 0.8;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    node.connect(master).connect(this.analyser).connect(context.destination);
    node.port.onmessage = (event: MessageEvent<FromWorklet>) => this.receive(event.data);
  }

  /** Builds the audio graph. The context starts suspended until resume() runs inside a user gesture. */
  static async create(): Promise<ChipEngine> {
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(processorUrl);
    const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    return new ChipEngine(context, node);
  }

  resume(): Promise<void> {
    return this.context.state === 'running' ? Promise.resolve() : this.context.resume();
  }

  setSong(song: Song): void {
    this.send({ type: 'song', song });
  }

  /**
   * Plays along with `transport`. `offset` converts its clock to this page's:
   * reference time = performance.now() + offset. Safe to call often; only a
   * new transport or a real shift in the mapping reaches the audio thread.
   */
  follow(transport: Transport, offset: number): void {
    const changed = transport !== this.transport;
    this.transport = transport;
    this.offset = offset;
    if (changed) this.errors = [];
    this.pushTiming(changed);

    if (transport.playing && !this.resyncTimer) {
      this.resyncTimer = setInterval(() => this.pushTiming(false), RESYNC_MS);
    } else if (!transport.playing && this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  preview(channel: number, note: number, volume: number): void {
    this.send({ type: 'preview', channel, note, volume });
  }

  release(channel: number): void {
    this.send({ type: 'release', channel });
  }

  setMutes(mutes: boolean[]): void {
    this.send({ type: 'mutes', mutes });
  }

  /**
   * The row coming out of the speakers right now. The worklet renders ahead of
   * the hardware, so this looks up the output clock instead of using the row
   * the worklet most recently processed.
   */
  audibleRow(): number | null {
    const now = this.outputTime();
    while (this.rows.length > 0 && this.rows[0]!.time <= now) {
      this.currentRow = this.rows.shift()!.row;
    }
    return this.currentRow;
  }

  stats(): EngineStats {
    const latency = this.context.baseLatency + (this.context.outputLatency || 0);
    const scheduleErrorMs =
      this.errors.length >= 4 ? this.errors.reduce((sum, e) => sum + Math.abs(e), 0) / this.errors.length : null;
    return { outputLatencyMs: latency * 1000, scheduleErrorMs };
  }

  /** The latest row the audio thread started, and the performance time it reaches the speakers. */
  lastRowHeard(): { absRow: number; perfTime: number } | null {
    return this.lastHeard;
  }

  close(): Promise<void> {
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.node.port.onmessage = null;
    return this.context.close();
  }

  private pushTiming(force: boolean): void {
    const transport = this.transport;
    if (!transport?.playing) {
      if (this.sent || force) this.send({ type: 'timing', timing: null });
      this.sent = null;
      this.rows = [];
      this.currentRow = null;
      return;
    }

    const anchorPerf = transport.anchorTime - this.offset;
    const timing: Timing = {
      anchorFrame: this.contextTimeHeardAt(anchorPerf) * this.context.sampleRate,
      anchorRow: transport.anchorRow,
      framesPerRow: framesPerRow(this.context.sampleRate, transport.bpm, transport.rowsPerBeat),
    };

    const sent = this.sent;
    const threshold = (RESYNC_THRESHOLD_MS / 1000) * this.context.sampleRate;
    const same =
      sent &&
      sent.anchorRow === timing.anchorRow &&
      sent.framesPerRow === timing.framesPerRow &&
      Math.abs(sent.anchorFrame - timing.anchorFrame) < threshold;
    if (!force && same) return;

    this.sent = timing;
    this.send({ type: 'timing', timing });
  }

  /**
   * The AudioContext time whose sample reaches the speakers at performance
   * time `perfMs`. getOutputTimestamp() pairs the two clocks at the output, so
   * output latency is already included.
   */
  private contextTimeHeardAt(perfMs: number): number {
    const { contextTime, performanceTime } = this.context.getOutputTimestamp();
    if (contextTime && performanceTime) return contextTime + (perfMs - performanceTime) / 1000;
    // Before audio is flowing the timestamp is empty: estimate from the latencies.
    const latency = this.context.baseLatency + (this.context.outputLatency || 0);
    return this.context.currentTime - latency + (perfMs - performance.now()) / 1000;
  }

  /** Inverse of contextTimeHeardAt: when a context time reaches the speakers, in performance time. */
  private perfTimeHeardAt(contextSeconds: number): number | null {
    const { contextTime, performanceTime } = this.context.getOutputTimestamp();
    if (!contextTime || !performanceTime) return null;
    return performanceTime + (contextSeconds - contextTime) * 1000;
  }

  private outputTime(): number {
    const { contextTime } = this.context.getOutputTimestamp();
    if (contextTime !== undefined && contextTime > 0) return contextTime;
    return this.context.currentTime - this.context.baseLatency - (this.context.outputLatency || 0);
  }

  private receive(message: FromWorklet): void {
    if (message.type === 'stopped') {
      this.rows = [];
      this.currentRow = null;
      return;
    }
    const time = message.frame / this.context.sampleRate;
    this.rows.push({ row: message.row, time });

    // Measure against the schedule. Rows before the anchor belong to an
    // earlier tempo, so they aren't comparable.
    const transport = this.transport;
    const heard = this.perfTimeHeardAt(time);
    if (heard !== null) this.lastHeard = { absRow: message.absRow, perfTime: heard };
    if (transport?.playing && heard !== null && message.absRow >= transport.anchorRow) {
      this.errors.push(heard + this.offset - timeOfRow(transport, message.absRow));
      if (this.errors.length > ERROR_WINDOW) this.errors.shift();
    }
  }

  private send(message: ToWorklet): void {
    this.node.port.postMessage(message);
  }
}
