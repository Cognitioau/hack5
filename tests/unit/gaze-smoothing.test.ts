import { describe, expect, it } from 'vitest';
import { OneEuroFilter, PointSmoother } from '../../src/features/gaze/smoothing';
import { GAZE_TUNING } from '../../src/features/gaze/tuning';
import { random } from './helpers/gaze-synthetic';

const FRAME_MS = 80;
const deviation = (values: readonly number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};

describe('One Euro live-estimate smoothing', () => {
  it('cuts steady-gaze jitter at the lab frame rate by more than half', () => {
    for (const sigma of [20, 40, 80]) {
      const rng = random(sigma);
      const filter = new OneEuroFilter();
      const raw: number[] = [];
      const smoothed: number[] = [];
      for (let frame = 0; frame < 400; frame++) {
        const value = 600 + sigma * rng.gaussian();
        const output = filter.filter(value, frame * FRAME_MS);
        if (frame >= 25) {
          raw.push(value);
          smoothed.push(output);
        }
      }
      expect(deviation(smoothed)).toBeLessThan(0.55 * deviation(raw));
    }
  });

  it('follows a saccade faster than a fixed low-pass at the same resting cutoff', () => {
    const settle = (beta: number) => {
      const filter = new OneEuroFilter({ ...GAZE_TUNING.smoothing, beta });
      for (let frame = 0; frame < 20; frame++) filter.filter(200, frame * FRAME_MS);
      for (let frame = 20; frame < 60; frame++)
        if (filter.filter(800, frame * FRAME_MS) >= 740) return (frame - 19) * FRAME_MS;
      return Number.POSITIVE_INFINITY;
    };
    const adaptive = settle(GAZE_TUNING.smoothing.beta);
    expect(adaptive).toBeLessThanOrEqual(480);
    expect(adaptive).toBeLessThan(settle(0));
  });

  it('starts from the first value, holds on non-increasing time and rejects bad input', () => {
    const filter = new OneEuroFilter();
    expect(filter.filter(123, 1000)).toBe(123);
    const next = filter.filter(223, 1080);
    expect(next).toBeGreaterThan(123);
    expect(next).toBeLessThan(223);
    expect(filter.filter(999, 1080)).toBe(next);
    expect(filter.filter(999, 1000)).toBe(next);
    expect(() => filter.filter(Number.NaN, 1200)).toThrow();
    expect(() => new OneEuroFilter({ minCutoffHz: 0, beta: 0, derivativeCutoffHz: 1 })).toThrow();
    filter.reset();
    expect(filter.filter(5, 2000)).toBe(5);
  });

  it('restarts a point after a long gap instead of gliding from a stale position', () => {
    const smoother = new PointSmoother();
    smoother.update({ x: 0, y: 0 }, 0);
    smoother.update({ x: 0, y: 0 }, 80);
    expect(smoother.update({ x: 900, y: 500 }, 80 + GAZE_TUNING.smoothing.resetGapMs + 1)).toEqual({
      x: 900,
      y: 500,
    });
    const glided = smoother.update({ x: 0, y: 0 }, 80 + GAZE_TUNING.smoothing.resetGapMs + 81);
    expect(glided.x).toBeGreaterThan(0);
  });
});
