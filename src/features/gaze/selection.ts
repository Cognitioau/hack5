import {
  GAZE_VARIANTS,
  fitGaze,
  predictGaze,
  type GazeModel,
  type GazeVariant,
} from './calibration';
import { median } from './collector';
import { GAZE_TUNING } from './tuning';

/** One captured calibration target: its training frames and its robust aggregate. */
export type CalibrationPoint = {
  target: { x: number; y: number };
  rows: readonly (readonly number[])[];
  features: readonly number[];
};
export type Viewport = { width: number; height: number };
export type Candidate = { variant: GazeVariant; lambda: number };
export type CandidateScore = Candidate & {
  medianPixels: number;
  meanPixels: number;
  maximumPixels: number;
};
export type Selection = { model: GazeModel; chosen: CandidateScore; table: CandidateScore[] };

export const pixelError = (
  prediction: { x: number; y: number },
  target: { x: number; y: number },
  viewport: Viewport,
) =>
  Math.hypot(
    (prediction.x - target.x) * viewport.width,
    (prediction.y - target.y) * viewport.height,
  );

export const defaultCandidates = (
  variants: readonly GazeVariant[] = GAZE_VARIANTS,
  lambdas: readonly number[] = GAZE_TUNING.model.lambdaGrid,
): Candidate[] => variants.flatMap((variant) => lambdas.map((lambda) => ({ variant, lambda })));

const samplesOf = (points: readonly CalibrationPoint[]) =>
  points.flatMap((point) =>
    point.rows.map((row) => ({ features: [...row], target: point.target })),
  );

export function fitPoints(
  points: readonly CalibrationPoint[],
  candidate: Candidate,
  minimumTargets = 9,
): GazeModel {
  return fitGaze(samplesOf(points), candidate.lambda, {
    variant: candidate.variant,
    minimumTargets,
  });
}

/**
 * Leave-one-target-out cross-validation: each target is predicted from its aggregate features by
 * a model fitted without any of its frames. Frames within a target are correlated, so holding out
 * single frames would be optimistic. On a 3×3 grid most folds extrapolate to the edge, which is a
 * deliberately conservative estimate.
 */
export function crossValidate(
  points: readonly CalibrationPoint[],
  viewport: Viewport,
  candidates: readonly Candidate[] = defaultCandidates(),
): CandidateScore[] {
  if (points.length < 3) throw new Error('Cross-validation needs at least three targets');
  return candidates.map((candidate) => {
    const errors = points.map((held, index) => {
      try {
        const model = fitPoints(
          points.filter((_, other) => other !== index),
          candidate,
          points.length - 1,
        );
        const prediction = predictGaze(model, held.features);
        return prediction
          ? pixelError(prediction, held.target, viewport)
          : Number.POSITIVE_INFINITY;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    });
    return {
      ...candidate,
      medianPixels: median(errors),
      meanPixels: errors.reduce((sum, value) => sum + value, 0) / errors.length,
      maximumPixels: Math.max(...errors),
    };
  });
}

/** Lowest mean error, except that a simpler candidate within the margin wins (one-SE style). */
export function chooseCandidate(
  table: readonly CandidateScore[],
  margin: number = GAZE_TUNING.model.simplicityMargin,
): CandidateScore {
  const finite = table.filter((score) => Number.isFinite(score.meanPixels));
  if (!finite.length) throw new Error('No calibration model could be cross-validated');
  const best = Math.min(...finite.map((score) => score.meanPixels));
  const simplest = [...finite].sort(
    (a, b) =>
      GAZE_VARIANTS.indexOf(a.variant) - GAZE_VARIANTS.indexOf(b.variant) || b.lambda - a.lambda,
  );
  const chosen = simplest.find((score) => score.meanPixels <= best * (1 + margin));
  if (!chosen) throw new Error('No calibration model could be cross-validated');
  return chosen;
}

export function selectGazeModel(
  points: readonly CalibrationPoint[],
  viewport: Viewport,
  candidates: readonly Candidate[] = defaultCandidates(),
): Selection {
  const table = crossValidate(points, viewport, candidates);
  const chosen = chooseCandidate(table);
  return { model: fitPoints(points, chosen, Math.min(9, points.length)), chosen, table };
}
