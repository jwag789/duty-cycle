import {
  CHANNELS,
  DUTY_CYCLES,
  MAX_VOLUME,
  midiToFreq,
  NOTE_OFF,
  type Cell,
  type ChannelKind,
  type ChannelSettings,
} from '@duty-cycle/protocol/core';

/** The NES APU's NTSC noise timer periods, in CPU cycles, from fastest to slowest. */
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const CPU_HZ = 1_789_773;
/** Lowest note that maps to a noise pitch; the 15 notes above it cover the rest. */
const NOISE_BASE_NOTE = 48;

const MIX: Record<ChannelKind, number> = { pulse: 0.2, triangle: 0.3, noise: 0.16 };
/** Volume units lost per second for each unit of ChannelSettings.decay. */
const DECAY_UNITS_PER_SECOND = 8;
/** Every amplitude change is smoothed over about this long, so nothing clicks. */
const SMOOTH_SECONDS = 0.002;
const HIGHPASS_HZ = 37;
const LOWPASS_HZ = 14_000;

/** How fast the noise LFSR is clocked for a cell note. Higher notes clock faster (brighter). */
export function noiseClockHz(note: number): number {
  const step = Math.min(15, Math.max(0, note - NOISE_BASE_NOTE));
  return CPU_HZ / NOISE_PERIODS[15 - step]!;
}

/** One step of the APU's 15-bit noise shift register. Short mode taps bit 6 instead of bit 1. */
export function stepLfsr(register: number, short: boolean): number {
  const feedback = (register ^ (register >> (short ? 6 : 1))) & 1;
  return (register >> 1) | (feedback << 14);
}

/** Polynomial band-limited step: smooths a hard edge across the two samples around it. */
function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

class Voice {
  /** Envelope level, 0–15, falling while the gate is open if the channel decays. */
  level = 0;
  gate = false;
  /** Smoothed output gain, 0–1. */
  amp = 0;
  phase = 0;
  /** Phase advance per sample (oscillator cycles, or noise clocks for the noise channel). */
  increment = 0;
  lfsr = 1;
}

/**
 * Four NES-style voices and a mixer, rendered one sample at a time.
 * Pure TypeScript with no Web Audio dependency, so the same code runs in the
 * AudioWorklet, in offline renders and in Node tests.
 */
export class ChipSynth {
  readonly voices = CHANNELS.map(() => new Voice());
  mutes: boolean[] = CHANNELS.map(() => false);
  private settings: ChannelSettings[];
  private readonly smoothK: number;
  private readonly highpassR: number;
  private readonly lowpassK: number;
  private highpassIn = 0;
  private highpassOut = 0;
  private lowpassOut = 0;

  constructor(
    readonly sampleRate: number,
    settings: ChannelSettings[],
  ) {
    this.settings = settings;
    this.smoothK = 1 - Math.exp(-1 / (SMOOTH_SECONDS * sampleRate));
    this.highpassR = 1 - (2 * Math.PI * HIGHPASS_HZ) / sampleRate;
    this.lowpassK = 1 - Math.exp((-2 * Math.PI * LOWPASS_HZ) / sampleRate);
  }

  setSettings(settings: ChannelSettings[]): void {
    this.settings = settings;
  }

  noteOn(channel: number, note: number, volume: number = MAX_VOLUME): void {
    const voice = this.voices[channel];
    if (!voice) return;
    const hz = CHANNELS[channel]!.kind === 'noise' ? noiseClockHz(note) : midiToFreq(note);
    voice.increment = hz / this.sampleRate;
    voice.level = volume;
    voice.gate = true;
    // Phase is left running: resetting it on every note is what makes cheap chip emulators click.
  }

  noteOff(channel: number): void {
    const voice = this.voices[channel];
    if (voice) voice.gate = false;
  }

  releaseAll(): void {
    for (const voice of this.voices) voice.gate = false;
  }

  /** Tracker semantics: a note retriggers, NOTE_OFF releases, a lone volume changes the held note. */
  applyCell(channel: number, cell: Cell): void {
    if (cell.note === NOTE_OFF) this.noteOff(channel);
    else if (cell.note !== null) this.noteOn(channel, cell.note, cell.volume ?? MAX_VOLUME);
    else if (cell.volume !== null) {
      const voice = this.voices[channel];
      if (voice) voice.level = cell.volume;
    }
  }

  /** Renders and returns the next sample, roughly in -1..1. */
  render(): number {
    let mix = 0;
    for (let channel = 0; channel < this.voices.length; channel++) {
      const voice = this.voices[channel]!;
      const settings = this.settings[channel]!;
      const kind = CHANNELS[channel]!.kind;

      if (voice.gate && settings.decay > 0) {
        voice.level = Math.max(0, voice.level - (settings.decay * DECAY_UNITS_PER_SECOND) / this.sampleRate);
      }
      const target = voice.gate && !this.mutes[channel] ? voice.level / MAX_VOLUME : 0;
      voice.amp += (target - voice.amp) * this.smoothK;

      mix += this.oscillate(voice, kind, settings) * voice.amp * MIX[kind];
    }

    // DC blocker, then a gentle low-pass, roughly where the console's own output filters sit.
    this.highpassOut = mix - this.highpassIn + this.highpassR * this.highpassOut;
    this.highpassIn = mix;
    this.lowpassOut += (this.highpassOut - this.lowpassOut) * this.lowpassK;
    return Math.tanh(this.lowpassOut);
  }

  private oscillate(voice: Voice, kind: ChannelKind, settings: ChannelSettings): number {
    const t = voice.phase;
    const dt = voice.increment;
    switch (kind) {
      case 'pulse': {
        const duty = DUTY_CYCLES[settings.duty] ?? 0.5;
        let sample = t < duty ? 1 : -1;
        sample += polyBlep(t, dt);
        sample -= polyBlep((t + 1 - duty) % 1, dt);
        voice.phase = advance(t, dt);
        return sample;
      }
      case 'triangle': {
        // The APU triangle is a 32-step staircase, not a smooth ramp. The steps are the sound.
        const step = Math.floor(t * 32);
        voice.phase = advance(t, dt);
        return (step < 16 ? 15 - step : step - 16) / 7.5 - 1;
      }
      case 'noise': {
        voice.phase = t + dt;
        while (voice.phase >= 1) {
          voice.phase -= 1;
          voice.lfsr = stepLfsr(voice.lfsr, settings.shortNoise);
        }
        return voice.lfsr & 1 ? -1 : 1;
      }
    }
  }
}

function advance(phase: number, increment: number): number {
  const next = phase + increment;
  return next >= 1 ? next - Math.floor(next) : next;
}
