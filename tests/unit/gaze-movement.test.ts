import { describe, expect, it } from 'vitest';
import { MovementGuard, headDeviation, headReference } from '../../src/features/gaze/movement';
import { GAZE_TUNING } from '../../src/features/gaze/tuning';
import { STILL_HEAD, rawFeatures } from './helpers/gaze-synthetic';

const reference = headReference([rawFeatures(0, 0), rawFeatures(0.05, 0.02)]);
const at = (head: Partial<typeof STILL_HEAD>) => rawFeatures(0, 0, { ...STILL_HEAD, ...head });
const { distanceRatio, centreShift, hysteresis } = GAZE_TUNING.movement;

describe('post-calibration head-movement guard', () => {
  it('measures distance and eye-centre changes relative to the calibrated position', () => {
    expect(reference).toEqual({ centreX: 0.5, centreY: 0.45, distance: 0.14 });
    if (!reference) throw new Error('reference');
    expect(headDeviation(reference, at({ distance: 0.154 }))?.distanceRatio).toBeCloseTo(0.1, 6);
    expect(headDeviation(reference, at({ centreX: 0.57 }))?.centreShift).toBeCloseTo(0.5, 6);
    expect(headDeviation(reference, [1, 2])).toBeUndefined();
    expect(headReference([])).toBeUndefined();
  });

  it('warns beyond either limit and clears only once back inside the hysteresis band', () => {
    if (!reference) throw new Error('reference');
    const guard = new MovementGuard(reference);
    expect(guard.update(at({}))).toBe(false);
    expect(guard.update(at({ distance: 0.14 * (1 + distanceRatio * 0.95) }))).toBe(false);
    expect(guard.update(at({ distance: 0.14 * (1 + distanceRatio * 1.05) }))).toBe(true);
    // Just inside the limit is not enough to clear an active warning.
    expect(guard.update(at({ distance: 0.14 * (1 + distanceRatio * 0.95) }))).toBe(true);
    expect(guard.update(at({ distance: 0.14 * (1 + distanceRatio * hysteresis * 0.9) }))).toBe(
      false,
    );
    expect(guard.update(at({ distance: 0.14 * (1 - distanceRatio * 1.05) }))).toBe(true);
    expect(guard.update(at({}))).toBe(false);
    expect(guard.update(at({ centreY: 0.45 + 0.14 * centreShift * 1.1 }))).toBe(true);
    expect(guard.moved).toBe(true);
    expect(guard.update(at({}))).toBe(false);
    expect(guard.update([Number.NaN])).toBe(true);
  });
});
