import { describe, expect, it } from 'vitest';
import {
  TargetCollector,
  rejectOutliers,
  replayTarget,
  windowSpread,
} from '../../src/features/gaze/collector';
import { GAZE_TUNING } from '../../src/features/gaze/tuning';
import { random, rawFeatures } from './helpers/gaze-synthetic';

const FRAME_MS = 80;
const { settleMs, stableSamples, stabilityTimeoutMs, lostResetMs, stabilityRange } =
  GAZE_TUNING.collection;

/** Gaze arrives at the target after a reaction/saccade period, then holds with small noise. */
function session(arrivalMs: number, seed = 1) {
  const rng = random(seed);
  return (t: number) =>
    t < arrivalMs
      ? rawFeatures(-0.08, -0.05)
      : rawFeatures(0.06 + 0.002 * rng.gaussian(), 0.03 + 0.002 * rng.gaussian());
}

describe('per-target settling, stability and robust aggregation', () => {
  it('drops the saccade period and captures only settled frames', () => {
    const collector = new TargetCollector();
    const frame = session(300);
    const states = [];
    for (let t = 0; t <= 2000 && !collector.result; t += FRAME_MS)
      states.push(collector.add(t, frame(t)));
    const captured = collector.result;
    expect(captured).toBeDefined();
    expect(states[0]).toEqual({ phase: 'settling', progress: 0 });
    expect(Math.min(...(captured?.usedTimes ?? []))).toBeGreaterThanOrEqual(settleMs);
    // Capture cannot happen before the settle period plus a full stable window.
    expect(captured?.capturedAt).toBeGreaterThanOrEqual(settleMs + (stableSamples - 1) * FRAME_MS);
    expect(captured?.stable).toBe(true);
    expect(captured?.features[0]).toBeCloseTo(0.06, 2);
    expect(captured?.features[1]).toBeCloseTo(0.03, 2);
    // Progress rises while collecting and is reported for the shrinking fixation dot.
    const collecting = states.filter((state) => state.phase === 'collecting');
    expect(collecting.at(-1)?.progress).toBeGreaterThan(collecting[0]?.progress ?? 1);
  });

  it('keeps a late saccade out of the aggregate through stability and outlier rejection', () => {
    const collector = new TargetCollector();
    const frame = session(600);
    for (let t = 0; t <= 3000 && !collector.result; t += FRAME_MS) collector.add(t, frame(t));
    expect(collector.result?.features[0]).toBeCloseTo(0.06, 2);
    expect(collector.result?.rows.every((row) => (row[0] ?? 0) > 0)).toBe(true);
  });

  it('never captures the previous fixation or a blend when the eye arrives late', () => {
    // Arrivals from inside the window (blend risk) to after a full window (stale risk).
    for (const arrival of [600, 650, 680, 700, 750, 900, 1200]) {
      const collector = new TargetCollector();
      const frame = session(arrival, arrival);
      for (let t = 0; t <= 6000 && !collector.result; t += FRAME_MS) collector.add(t, frame(t));
      expect(collector.result?.stable, `arrival ${arrival} ms`).toBe(true);
      expect(collector.result?.features[0], `arrival ${arrival} ms`).toBeCloseTo(0.06, 2);
      expect(
        Math.min(...(collector.result?.usedTimes ?? [])),
        `arrival ${arrival}`,
      ).toBeGreaterThanOrEqual(arrival);
    }
  });

  it('flags a point when the eyes never leave where they were as it appeared', () => {
    const collector = new TargetCollector();
    for (let t = 0; t <= 6000 && !collector.result; t += FRAME_MS)
      collector.add(t, rawFeatures(-0.08, -0.05));
    expect(collector.result?.stable).toBe(false);
    expect(collector.result?.spread).toBeLessThan(stabilityRange);
    expect(collector.result?.departure).toBeLessThan(GAZE_TUNING.collection.departureMin);
    expect(collector.result?.capturedAt).toBeGreaterThanOrEqual(settleMs + stabilityTimeoutMs);
  });

  it('judges departure only when the face was seen as the target appeared', () => {
    const collector = new TargetCollector();
    for (let t = 0; t <= 6000 && !collector.result; t += FRAME_MS)
      collector.add(t, t < 200 ? undefined : rawFeatures(-0.08, -0.05));
    expect(collector.result?.departure).toBeNull();
    expect(collector.result?.stable).toBe(true);
  });

  it('waits for stability, then captures by timeout and flags the target as unstable', () => {
    const collector = new TargetCollector();
    for (let t = 0; t <= 6000 && !collector.result; t += FRAME_MS)
      collector.add(t, rawFeatures(Math.sin(t / 50) * 0.2, 0));
    expect(collector.result?.stable).toBe(false);
    expect(collector.result?.capturedAt).toBeGreaterThanOrEqual(settleMs + stabilityTimeoutMs);
  });

  it('rejects a single wild frame from the aggregate, but a wild frame keeps a window unsteady', () => {
    const rows = Array.from({ length: 8 }, (_, index) => rawFeatures(0.05 + index * 0.0005, 0.02));
    expect(windowSpread(rows)).toBeLessThan(0.01);
    rows[3] = rawFeatures(0.4, 0.2);
    const kept = rejectOutliers(rows);
    expect(kept).not.toContain(3);
    expect(kept).toHaveLength(7);
    // Unlike a median absolute deviation, the range has no breakdown point: half a window on
    // the previous fixation (or one glitch) cannot pass as steady.
    expect(windowSpread(rows)).toBeGreaterThan(stabilityRange);
    const split = [...rows.slice(0, 4), ...rows.slice(0, 4).map(() => rawFeatures(-0.05, 0.02))];
    expect(windowSpread(split)).toBeGreaterThan(stabilityRange);
  });

  it('restarts the stable window after a lost face longer than a blink', () => {
    const blink = new TargetCollector();
    const lost = new TargetCollector();
    const frame = session(200);
    for (let t = 0; t <= 4000; t += FRAME_MS) {
      const gap = t >= 600 && t < 600 + lostResetMs + 2 * FRAME_MS;
      blink.add(t, t >= 600 && t < 760 ? undefined : frame(t));
      lost.add(t, gap ? undefined : frame(t));
    }
    expect(lost.result?.capturedAt).toBeGreaterThan(blink.result?.capturedAt ?? Infinity);
    expect(Math.min(...(lost.result?.usedTimes ?? []))).toBeGreaterThanOrEqual(
      600 + lostResetMs + 2 * FRAME_MS,
    );
  });

  it('freezes after capture and replays recorded frames to the identical result', () => {
    const collector = new TargetCollector();
    const frame = session(250, 9);
    for (let t = 0; t <= 2400; t += FRAME_MS)
      collector.add(t, t % 400 === 0 ? undefined : frame(t));
    const captured = collector.result;
    expect(collector.add(2480, rawFeatures(0.5, 0.5)).phase).toBe('captured');
    expect(collector.result).toBe(captured);
    expect(collector.samples.at(-1)?.t).toBe(2480);
    expect(replayTarget(collector.samples)).toEqual(captured);
    expect(
      replayTarget(collector.samples, {
        ...GAZE_TUNING.collection,
        settleMs: 0,
      }),
    ).not.toEqual(captured);
  });
});
