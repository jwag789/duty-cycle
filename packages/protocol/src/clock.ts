export interface ClockSample {
  /** Server clock minus local clock, in ms. */
  offset: number;
  /** Round trip of the ping that produced this sample, in ms. */
  rtt: number;
}

/**
 * One NTP-style exchange: sent at local `t0`, stamped `serverTime` by the
 * server, received at local `t3`. Assumes the two legs took equally long, so
 * the error is at most half the difference between them, and never more than
 * rtt / 2.
 */
export function sampleFromPing(t0: number, serverTime: number, t3: number): ClockSample {
  return { offset: serverTime - (t0 + t3) / 2, rtt: t3 - t0 };
}

/**
 * Keeps recent samples and trusts the one with the shortest round trip. A
 * fast round trip leaves the least room for the two legs to differ, so it
 * carries the least error. A sliding window lets the estimate follow a clock
 * that drifts or a network that changes.
 */
export class ClockEstimator {
  private samples: ClockSample[] = [];

  constructor(private readonly window = 16) {}

  add(sample: ClockSample): void {
    if (!Number.isFinite(sample.offset) || !(sample.rtt >= 0)) return;
    this.samples.push(sample);
    if (this.samples.length > this.window) this.samples.shift();
  }

  get best(): ClockSample | null {
    let best: ClockSample | null = null;
    for (const sample of this.samples) if (!best || sample.rtt < best.rtt) best = sample;
    return best;
  }

  get count(): number {
    return this.samples.length;
  }

  /** The most recent round trip, for display. */
  get lastRtt(): number | null {
    return this.samples.at(-1)?.rtt ?? null;
  }

  reset(): void {
    this.samples = [];
  }
}
