import { emptySong } from '@duty-cycle/protocol/core';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './messages';
import { Sequencer, type Timing } from './sequencer';
import { ChipSynth } from './synth';

// AudioWorkletGlobalScope isn't in TypeScript's DOM lib; declare the parts used here.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/**
 * Runs the sequencer on the audio thread, so row timing is sample-accurate and
 * keeps going when the main thread is busy or the tab is in the background.
 */
class ChipProcessor extends AudioWorkletProcessor {
  private readonly synth: ChipSynth;
  private readonly sequencer: Sequencer;
  /** The latest timing from the main thread, applied at the start of the next block. */
  private incoming: { timing: Timing | null } | null = null;

  constructor() {
    super();
    const song = emptySong();
    this.synth = new ChipSynth(sampleRate, song.channels);
    this.sequencer = new Sequencer(this.synth, song, (event) => this.send({ type: 'row', ...event }));
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.receive(event.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.incoming) {
      // Applied here, where currentFrame is exact, rather than in receive().
      const wasPlaying = this.sequencer.playing;
      this.sequencer.setTiming(this.incoming.timing, currentFrame);
      if (wasPlaying && !this.sequencer.playing) this.send({ type: 'stopped' });
      this.incoming = null;
    }
    const [left, right] = outputs[0] ?? [];
    if (!left) return true;
    for (let i = 0; i < left.length; i++) {
      const sample = this.sequencer.tick(currentFrame + i);
      left[i] = sample;
      if (right) right[i] = sample;
    }
    return true;
  }

  private receive(message: ToWorklet): void {
    switch (message.type) {
      case 'song':
        this.sequencer.setSong(message.song, message.queue);
        break;
      case 'timing':
        this.incoming = { timing: message.timing };
        break;
      case 'preview':
        this.synth.noteOn(message.channel, message.note, message.volume);
        break;
      case 'release':
        this.synth.noteOff(message.channel);
        break;
      case 'mutes':
        this.synth.mutes = message.mutes.slice();
        break;
    }
  }

  private send(message: FromWorklet): void {
    this.port.postMessage(message);
  }
}

registerProcessor(PROCESSOR_NAME, ChipProcessor);
