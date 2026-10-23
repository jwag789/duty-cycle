import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ClockEstimator, sampleFromPing } from './clock';
import { leadTimeMs, msPerRow, retempo, rowAt, rowStartingAfter, startTransport, STOPPED, timeOfRow, type Transport } from './transport';

describe('transport', () => {
  const playing = startTransport(STOPPED, { bpm: 120, rowsPerBeat: 4 }, 0, 10_000); // 125 ms per row

  it('maps rows to times and back', () => {
    expect(msPerRow(playing)).toBe(125);
    expect(timeOfRow(playing, 8)).toBe(11_000);
    expect(rowAt(playing, 11_000)).toBe(8);
  });

  it('starts a new epoch on every start, and keeps it across tempo changes', () => {
    expect(playing.epoch).toBe(1);
    expect(startTransport(playing, playing, 0, 0).epoch).toBe(2);
    expect(retempo(playing, { bpm: 90, rowsPerBeat: 4 }, 11_000).epoch).toBe(1);
  });

  it('finds the first row starting at or after a time', () => {
    expect(rowStartingAfter(playing, 11_000)).toBe(8);
    expect(rowStartingAfter(playing, 11_001)).toBe(9);
    expect(rowStartingAfter(playing, 0)).toBe(0); // never before the anchor
  });

  it('changes tempo on the first row boundary after the given time, without a jump', () => {
    const next = retempo(playing, { bpm: 240, rowsPerBeat: 4 }, 11_010); // just after row 8
    expect(next.anchorRow).toBe(9);
    expect(next.anchorTime).toBe(11_125); // when the old tempo reaches row 9
    expect(rowAt(next, 11_125 + 62.5)).toBe(10);
  });

  it('keeps time continuous across any tempo change', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 40, max: 300 }),
        fc.integer({ min: 40, max: 300 }),
        fc.double({ min: 0, max: 60_000, noNaN: true }),
        (from, to, after) => {
          const before = startTransport(STOPPED, { bpm: from, rowsPerBeat: 4 }, 0, 0);
          const next = retempo(before, { bpm: to, rowsPerBeat: 4 }, after);
          if (from === to) {
            expect(next).toBe(before);
            return;
          }
          // The switch lands on a whole row, no earlier than asked, at the old tempo's time for that row.
          expect(Number.isInteger(next.anchorRow)).toBe(true);
          expect(next.anchorTime).toBeGreaterThanOrEqual(after - 1e-6);
          expect(next.anchorTime).toBeCloseTo(timeOfRow(before, next.anchorRow), 6);
        },
      ),
    );
  });

  it('only records the tempo while stopped', () => {
    const stopped: Transport = { ...playing, playing: false };
    expect(retempo(stopped, { bpm: 90, rowsPerBeat: 4 }, 0)).toEqual({ ...stopped, bpm: 90 });
  });

  it('schedules far enough ahead for the slowest player', () => {
    expect(leadTimeMs([])).toBe(220); // assumes a 200 ms round trip
    expect(leadTimeMs([10, null])).toBe(150); // never less than the floor
    expect(leadTimeMs([20, 400])).toBe(320);
    expect(leadTimeMs([60_000])).toBe(1500); // never more than the ceiling
  });
});

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface SimClient {
  /** Local clock minus true time. The server's clock is true time. */
  skew: number;
  /** Fixed one-way delays to and from the server, in ms. */
  up: number;
  down: number;
  /** Random extra delay per leg, up to this much. */
  jitter: number;
}

/**
 * Runs the real estimator over a simulated network: 6 quick pings then 10
 * slower ones, each leg delayed by its base latency plus random jitter.
 * Returns the error, in ms, of when this client would play a row scheduled at
 * a given server time.
 */
function scheduleError(client: SimClient, random: () => number): { error: number; bestRtt: number } {
  const estimator = new ClockEstimator();
  let trueTime = 1_000_000;
  for (let i = 0; i < 16; i++) {
    trueTime += i < 6 ? 60 : 2000;
    const t0 = trueTime + client.skew;
    const atServer = trueTime + client.up + random() * client.jitter;
    const back = atServer + client.down + random() * client.jitter;
    estimator.add(sampleFromPing(t0, atServer, back + client.skew));
  }
  const best = estimator.best!;
  // A row at server time S is played at local S - offset, which is true time S - offset - skew.
  return { error: -best.offset - client.skew, bestRtt: best.rtt };
}

describe('clock sync', () => {
  it('two players with different clocks and networks start the same row within a few ms', () => {
    const random = rng(42);
    const nearby = scheduleError({ skew: -83_417.25, up: 12, down: 12, jitter: 30 }, random);
    const faraway = scheduleError({ skew: 5_190_002.5, up: 95, down: 95, jitter: 60 }, random);
    expect(Math.abs(nearby.error)).toBeLessThan(5);
    expect(Math.abs(faraway.error)).toBeLessThan(10);
    expect(Math.abs(nearby.error - faraway.error)).toBeLessThan(10);
  });

  it('is never off by more than half the best round trip, whatever the network', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e7, max: 1e7, noNaN: true }),
        fc.integer({ min: 1, max: 250 }),
        fc.integer({ min: 1, max: 250 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer(),
        (skew, up, down, jitter, seed) => {
          const { error, bestRtt } = scheduleError({ skew, up, down, jitter }, rng(seed));
          expect(Math.abs(error)).toBeLessThanOrEqual(bestRtt / 2 + 1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('cannot see a lopsided route: the error is half the asymmetry', () => {
    // 100 ms up, 20 ms down, no jitter: NTP's known blind spot. The slow
    // upload makes the server's stamp look late, so this player starts 40 ms early.
    const { error } = scheduleError({ skew: 0, up: 100, down: 20, jitter: 0 }, rng(1));
    expect(error).toBeCloseTo(-40, 6);
  });
});
