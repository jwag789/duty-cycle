import type { Song } from '@duty-cycle/protocol/core';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './messages';
import processorUrl from './processor.ts?worker&url';

interface ScheduledRow {
  row: number;
  /** AudioContext time the row starts. */
  time: number;
}

/**
 * Main-thread handle on the chip synth. Owns the AudioContext and the worklet
 * node, and turns the worklet's row events into "which row is audible now".
 */
export class ChipEngine {
  readonly analyser: AnalyserNode;
  private rows: ScheduledRow[] = [];
  private currentRow: number | null = null;

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

  play(fromRow = 0): void {
    this.rows = [];
    this.currentRow = null;
    this.send({ type: 'play', fromRow });
  }

  stop(): void {
    this.rows = [];
    this.currentRow = null;
    this.send({ type: 'stop' });
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

  close(): Promise<void> {
    this.node.port.onmessage = null;
    return this.context.close();
  }

  private outputTime(): number {
    const { contextTime } = this.context.getOutputTimestamp();
    if (contextTime !== undefined && contextTime > 0) return contextTime;
    return this.context.currentTime - this.context.baseLatency - (this.context.outputLatency || 0);
  }

  private receive(message: FromWorklet): void {
    if (message.type === 'row') {
      this.rows.push({ row: message.row, time: message.frame / this.context.sampleRate });
    } else {
      this.rows = [];
      this.currentRow = null;
    }
  }

  private send(message: ToWorklet): void {
    this.node.port.postMessage(message);
  }
}
