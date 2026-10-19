import { describe, expect, it } from 'vitest';
import { fitGaze, predictGaze } from '../../src/features/gaze/calibration';
import {
  chooseCandidate,
  crossValidate,
  pixelError,
  selectGazeModel,
  type CalibrationPoint,
  type CandidateScore,
} from '../../src/features/gaze/selection';
import {
  STILL_HEAD,
  calibrationTargets,
  framesFor,
  linearIris,
  point,
  random,
  validationTargets,
  type Head,
} from './helpers/gaze-synthetic';

const viewport = { width: 1280, height: 720 };
const best = (table: readonly CandidateScore[], variant: string) =>
  Math.min(...table.filter((score) => score.variant === variant).map((score) => score.meanPixels));

describe('per-session model selection by leave-one-target-out cross-validation', () => {
  it('selects the quadratic variant when the eye-to-screen map is quadratic', () => {
    const rng = random(3);
    // Choose iris offsets on a grid, then place each target by an exactly quadratic map.
    const points: CalibrationPoint[] = [-0.1, 0, 0.1].flatMap((h) =>
      [-0.07, 0, 0.07].map((v) => {
        const target = { x: 0.5 + 3 * h + 8 * h * h, y: 0.5 + 3 * v + 12 * v * v + 6 * h * v };
        return point(target, framesFor(h, v, 0.0005, rng));
      }),
    );
    const selection = selectGazeModel(points, viewport);
    expect(selection.chosen.variant).toBe('iris-quadratic');
    expect(best(selection.table, 'iris')).toBeGreaterThan(3 * selection.chosen.meanPixels);
    expect(selection.table).toHaveLength(24);
  });

  it('down-weights head features that only carry noise, preferring the iris-only model', () => {
    const rng = random(11);
    const drift = (): Head => ({
      ...STILL_HEAD,
      centreX: STILL_HEAD.centreX + 0.004 * rng.gaussian(),
      centreY: STILL_HEAD.centreY + 0.004 * rng.gaussian(),
      distance: STILL_HEAD.distance + 0.002 * rng.gaussian(),
      noseX: 0.01 * rng.gaussian(),
      noseY: STILL_HEAD.noseY + 0.01 * rng.gaussian(),
      yaw: 0.01 * rng.gaussian(),
    });
    const sample = (target: { x: number; y: number }) => {
      const { h, v } = linearIris(target);
      return point(target, framesFor(h, v, 0.004, rng, drift()));
    };
    const calibration = calibrationTargets.map(sample);
    const validation = validationTargets.map(sample);
    const selection = selectGazeModel(calibration, viewport);
    expect(selection.chosen.variant).toBe('iris');
    expect(best(selection.table, 'full')).toBeGreaterThan(selection.chosen.meanPixels);
    // The pre-tuning model (all ten features, lambda 0.5 per frame, no clipping) generalises worse.
    const legacy = fitGaze(
      calibration.flatMap((item) =>
        item.rows.map((row) => ({ features: [...row], target: item.target })),
      ),
      0.5,
      { variant: 'full', zLimit: Number.POSITIVE_INFINITY, equalTargetWeights: false },
    );
    const meanError = (model: typeof legacy) =>
      validation.reduce((sum, item) => {
        const prediction = predictGaze(model, item.features);
        return sum + (prediction ? pixelError(prediction, item.target, viewport) : Infinity);
      }, 0) / validation.length;
    expect(meanError(selection.model)).toBeLessThan(meanError(legacy));
  });

  it('keeps head-rotation terms when they genuinely explain where the person looked', () => {
    const rng = random(5);
    const calibration = calibrationTargets.map((target) => {
      const noseX = 0.04 * rng.gaussian();
      // The head turned between targets; the eyes made up the rest of the angle.
      const h = 0.2 * (target.x - 0.5) - 0.5 * noseX;
      return point(
        target,
        framesFor(h, 0.12 * (target.y - 0.5), 0.0005, rng, { ...STILL_HEAD, noseX }),
      );
    });
    const selection = selectGazeModel(calibration, viewport);
    expect(selection.chosen.variant).toBe('iris-head');
    expect(best(selection.table, 'iris')).toBeGreaterThan(2 * selection.chosen.meanPixels);
  });

  it('prefers the simpler, more regularised candidate on a near-tie and fails when nothing fits', () => {
    const score = (variant: CandidateScore['variant'], lambda: number, meanPixels: number) => ({
      variant,
      lambda,
      meanPixels,
      medianPixels: meanPixels,
      maximumPixels: meanPixels,
    });
    expect(
      chooseCandidate([score('full', 0.1, 100), score('iris', 0.1, 108), score('iris', 3, 109)]),
    ).toMatchObject({ variant: 'iris', lambda: 3 });
    expect(chooseCandidate([score('full', 0.1, 100), score('iris', 1, 125)]).variant).toBe('full');
    expect(() => chooseCandidate([score('iris', 1, Number.POSITIVE_INFINITY)])).toThrow();
    expect(() => crossValidate([], viewport)).toThrow();
  });
});
