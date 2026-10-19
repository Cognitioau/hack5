import { CALIBRATION_TARGETS, VALIDATION_TARGETS } from '../../../src/features/gaze/calibration';
import { TargetCollector } from '../../../src/features/gaze/collector';
import type { CalibrationPoint } from '../../../src/features/gaze/selection';

/** Deterministic PRNG so synthetic gaze sessions are reproducible. */
export function random(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gaussian };
}

export type Head = {
  centreX: number;
  centreY: number;
  distance: number;
  noseX: number;
  noseY: number;
  yaw: number;
};
export const STILL_HEAD: Head = {
  centreX: 0.5,
  centreY: 0.45,
  distance: 0.14,
  noseX: 0,
  noseY: 0.5,
  yaw: 0,
};

/** Ten raw features: identical iris offsets in both eyes plus head terms. */
export const rawFeatures = (h: number, v: number, head: Head = STILL_HEAD) => [
  h,
  v,
  h,
  v,
  head.centreX,
  head.centreY,
  head.distance,
  head.noseX,
  head.noseY,
  head.yaw,
];

/** A linear "true" eye: iris offset proportional to the gaze point's offset from centre. */
export const linearIris = (target: { x: number; y: number }) => ({
  h: 0.2 * (target.x - 0.5),
  v: 0.12 * (target.y - 0.5),
});

/** Frames for one target, with per-frame iris noise and an optional per-target head pose. */
export function framesFor(
  h: number,
  v: number,
  noise: number,
  rng: ReturnType<typeof random>,
  head: Head = STILL_HEAD,
  count = 8,
) {
  return Array.from({ length: count }, () =>
    rawFeatures(h + noise * rng.gaussian(), v + noise * rng.gaussian(), head).map((value, index) =>
      index < 4 ? value : value + 0.0005 * rng.gaussian(),
    ),
  );
}

export function point(target: { x: number; y: number }, rows: number[][]): CalibrationPoint {
  const features = (rows[0] ?? []).map((_, index) => {
    const values = rows.map((row) => row[index] ?? 0).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2
      ? (values[middle] ?? 0)
      : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
  });
  return { target, rows, features };
}

export const calibrationTargets = CALIBRATION_TARGETS.map((target) => ({ ...target }));
export const validationTargets = VALIDATION_TARGETS.map((target) => ({ ...target }));

/**
 * Runs a whole synthetic lab session through the real collector: the eye reaches each target
 * after a reaction delay, holds with noise, and the person advances a little after capture.
 */
export function simulateRecords(
  targets: readonly { x: number; y: number }[],
  rng: ReturnType<typeof random>,
  options: { arrivalMs?: number; noise?: number; extraFrames?: number } = {},
) {
  const { arrivalMs = 250, noise = 0.002, extraFrames = 5 } = options;
  let previous = { x: 0.5, y: 0.5 };
  return targets.map((target, index) => {
    const collector = new TargetCollector();
    let after = -1;
    for (let t = 0; after < extraFrames && t < 8000; t += 80) {
      const gaze = t < arrivalMs ? previous : target;
      const { h, v } = linearIris(gaze);
      const features = rawFeatures(h + noise * rng.gaussian(), v + noise * rng.gaussian());
      collector.add(t, t % 1040 === 960 ? undefined : features);
      if (collector.result) after++;
    }
    previous = target;
    const captured = collector.result;
    if (!captured) throw new Error('Synthetic target was not captured');
    return { index, target, samples: [...collector.samples], captured };
  });
}
