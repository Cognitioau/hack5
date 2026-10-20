import { GAZE_TUNING } from './tuning';

export type Landmark = { x: number; y: number; z: number };
export type Sample = { features: number[]; target: { x: number; y: number } };
export type ViewportGeometry = {
  width: number;
  height: number;
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  pixelRatio: number;
};

/** The ten geometric values eyeFeatures returns, in order. No image or identity data. */
export const FEATURE_NAMES = [
  'leftIrisHorizontal',
  'leftIrisVertical',
  'rightIrisHorizontal',
  'rightIrisVertical',
  'eyeCentreX',
  'eyeCentreY',
  'interEyeDistance',
  'noseOffsetX',
  'noseOffsetY',
  'eyeDepthYaw',
] as const;
export const FEATURE_INDEX = { centreX: 4, centreY: 5, distance: 6 } as const;

/** Candidate feature maps, simplest first; model selection prefers earlier entries on near-ties. */
export const GAZE_VARIANTS = ['iris', 'iris-quadratic', 'iris-head', 'full'] as const;
export type GazeVariant = (typeof GAZE_VARIANTS)[number];
export const VARIANT_LABELS: Record<GazeVariant, string> = {
  iris: 'iris only, linear',
  'iris-quadratic': 'iris with quadratic terms',
  'iris-head': 'iris plus head-rotation terms',
  full: 'all ten features, linear',
};

/** Maps raw features into a variant's regression inputs; full keeps any raw vector as given. */
export function variantFeatures(
  variant: GazeVariant,
  raw: readonly number[],
): number[] | undefined {
  if (variant === 'full') return [...raw];
  if (raw.length !== FEATURE_NAMES.length) return undefined;
  const [leftH = 0, leftV = 0, rightH = 0, rightV = 0] = raw;
  if (variant === 'iris') return [leftH, leftV, rightH, rightV];
  if (variant === 'iris-head') return [leftH, leftV, rightH, rightV, raw[7] ?? 0, raw[8] ?? 0];
  const h = (leftH + rightH) / 2;
  const v = (leftV + rightV) / 2;
  return [h, v, h * h, v * v, h * v];
}

export type GazeModel = {
  variant: GazeVariant;
  lambda: number;
  zLimit: number;
  means: number[];
  scales: number[];
  weightsX: number[];
  weightsY: number[];
};

export const CALIBRATION_TARGETS = [
  { x: 0.1, y: 0.15 },
  { x: 0.5, y: 0.15 },
  { x: 0.9, y: 0.15 },
  { x: 0.9, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.5 },
  { x: 0.1, y: 0.85 },
  { x: 0.5, y: 0.85 },
  { x: 0.9, y: 0.85 },
] as const;
export const VALIDATION_TARGETS = [
  { x: 0.3, y: 0.3 },
  { x: 0.7, y: 0.3 },
  { x: 0.5, y: 0.4 },
  { x: 0.3, y: 0.7 },
  { x: 0.7, y: 0.7 },
] as const;

/** Geometric features only; no image patches, frames or identity representations. */
export function eyeFeatures(points: readonly Landmark[]): number[] | undefined {
  if (points.length < 478) return undefined;
  const point = (index: number) => points[index];
  const needed = [33, 133, 159, 145, 362, 263, 386, 374, 468, 473, 1];
  if (
    needed.some(
      (index) => !point(index) || !Object.values(point(index) ?? {}).every(Number.isFinite),
    )
  )
    return undefined;
  const eye = (
    outerIndex: number,
    innerIndex: number,
    topIndex: number,
    bottomIndex: number,
    irisIndex: number,
  ) => {
    const outer = point(outerIndex);
    const inner = point(innerIndex);
    const top = point(topIndex);
    const bottom = point(bottomIndex);
    const iris = point(irisIndex);
    if (!outer || !inner || !top || !bottom || !iris) return undefined;
    const dx = inner.x - outer.x;
    const dy = inner.y - outer.y;
    const width = Math.hypot(dx, dy);
    if (width < 0.005 || Math.hypot(top.x - bottom.x, top.y - bottom.y) / width < 0.08)
      return undefined;
    const center = { x: (outer.x + inner.x) / 2, y: (outer.y + inner.y) / 2 };
    return {
      center,
      horizontal: ((iris.x - center.x) * dx + (iris.y - center.y) * dy) / width ** 2,
      vertical: (-(iris.x - center.x) * dy + (iris.y - center.y) * dx) / width ** 2,
    };
  };
  const left = eye(33, 133, 159, 145, 468);
  const right = eye(362, 263, 386, 374, 473);
  const nose = point(1);
  if (!left || !right || !nose) return undefined;
  const distance = Math.hypot(right.center.x - left.center.x, right.center.y - left.center.y);
  if (distance < 0.01) return undefined;
  const center = {
    x: (left.center.x + right.center.x) / 2,
    y: (left.center.y + right.center.y) / 2,
  };
  return [
    left.horizontal,
    left.vertical,
    right.horizontal,
    right.vertical,
    center.x,
    center.y,
    distance,
    (nose.x - center.x) / distance,
    (nose.y - center.y) / distance,
    ((point(33)?.z ?? 0) - (point(263)?.z ?? 0)) / distance,
  ];
}

function solve(matrix: number[][], rhs: number[]): number[] {
  const rows = matrix.map((row, index) => [...row, rhs[index] ?? 0]);
  const n = rhs.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) pivot = row;
    const current = rows[pivot];
    const previous = rows[column];
    if (!current || !previous || Math.abs(current[column] ?? 0) < 1e-10)
      throw new Error('Calibration samples do not contain enough independent information');
    rows[column] = current;
    rows[pivot] = previous;
    const divisor = current[column] ?? 1;
    for (let k = column; k <= n; k++) current[k] = (current[k] ?? 0) / divisor;
    for (let row = 0; row < n; row++) {
      const values = rows[row];
      if (row === column || !values) continue;
      const factor = values[column] ?? 0;
      for (let k = column; k <= n; k++) values[k] = (values[k] ?? 0) - factor * (current[k] ?? 0);
    }
  }
  return rows.map((row) => row[n] ?? 0);
}

const targetKey = (target: { x: number; y: number }) => `${target.x},${target.y}`;
const standardise = (value: number, mean: number, scale: number, limit: number) =>
  Math.max(-limit, Math.min(limit, (value - mean) / scale));

/**
 * Ridge regression on standardised variant features. Each distinct target carries a total weight
 * of one however many frames it contributed, so lambda means the same thing in every session
 * (the original lab weighted every frame equally with lambda 0.5, roughly 0.05 on this scale).
 * Standardised inputs are clipped so a feature that barely varied during calibration cannot
 * produce unbounded extrapolation later.
 */
export function fitGaze(
  samples: readonly Sample[],
  regularization = 1,
  options: {
    variant?: GazeVariant;
    minimumTargets?: number;
    zLimit?: number;
    /** False reproduces the original per-frame weighting; only the offline legacy row uses it. */
    equalTargetWeights?: boolean;
  } = {},
): GazeModel {
  const variant = options.variant ?? 'full';
  const minimumTargets = options.minimumTargets ?? 9;
  const zLimit = options.zLimit ?? GAZE_TUNING.model.zLimit;
  const raw = samples[0]?.features.length ?? 0;
  if (
    samples.length < minimumTargets ||
    !raw ||
    raw > 32 ||
    regularization <= 0 ||
    !Number.isFinite(regularization) ||
    !(zLimit > 0)
  )
    throw new Error('Complete all calibration points first');
  if (
    samples.some(
      (sample) =>
        sample.features.length !== raw ||
        ![...sample.features, sample.target.x, sample.target.y].every(Number.isFinite) ||
        sample.target.x < 0 ||
        sample.target.x > 1 ||
        sample.target.y < 0 ||
        sample.target.y > 1,
    )
  )
    throw new Error('Invalid calibration sample');
  const counts = new Map<string, number>();
  for (const sample of samples)
    counts.set(targetKey(sample.target), (counts.get(targetKey(sample.target)) ?? 0) + 1);
  if (counts.size < minimumTargets)
    throw new Error(
      `Calibration needs ${minimumTargets === 9 ? 'nine' : minimumTargets} distinct targets`,
    );
  const inputs = samples.map((sample) => variantFeatures(variant, sample.features));
  if (inputs.some((input) => !input)) throw new Error(`Variant ${variant} needs all eye features`);
  const features = inputs as number[][];
  const equal = options.equalTargetWeights ?? true;
  const weights = samples.map((sample) =>
    equal ? 1 / (counts.get(targetKey(sample.target)) ?? 1) : 1,
  );
  const total = equal ? counts.size : samples.length;
  const dimensions = features[0]?.length ?? 0;
  const means = Array.from(
    { length: dimensions },
    (_, index) =>
      features.reduce((sum, row, sample) => sum + (weights[sample] ?? 0) * (row[index] ?? 0), 0) /
      total,
  );
  const scales = means.map((mean, index) =>
    Math.max(
      1e-4,
      Math.sqrt(
        features.reduce(
          (sum, row, sample) => sum + (weights[sample] ?? 0) * ((row[index] ?? 0) - mean) ** 2,
          0,
        ) / total,
      ),
    ),
  );
  const rows = features.map((row) => [
    1,
    ...row.map((value, index) => standardise(value, means[index] ?? 0, scales[index] ?? 1, zLimit)),
  ]);
  const matrix = Array.from({ length: dimensions + 1 }, (_, i) =>
    Array.from(
      { length: dimensions + 1 },
      (_, j) =>
        rows.reduce(
          (sum, row, sample) => sum + (weights[sample] ?? 0) * (row[i] ?? 0) * (row[j] ?? 0),
          0,
        ) + (i === j ? (i === 0 ? 1e-6 : regularization) : 0),
    ),
  );
  const rhs = (coordinate: 'x' | 'y') =>
    Array.from({ length: dimensions + 1 }, (_, index) =>
      rows.reduce(
        (sum, row, sample) =>
          sum +
          (weights[sample] ?? 0) * (row[index] ?? 0) * (samples[sample]?.target[coordinate] ?? 0),
        0,
      ),
    );
  return {
    variant,
    lambda: regularization,
    zLimit,
    means,
    scales,
    weightsX: solve(matrix, rhs('x')),
    weightsY: solve(matrix, rhs('y')),
  };
}

export function predictGaze(
  model: GazeModel,
  features: readonly number[],
): { x: number; y: number } | undefined {
  if (!features.every(Number.isFinite)) return undefined;
  const input = variantFeatures(model.variant, features);
  if (!input || input.length !== model.means.length) return undefined;
  const row = [
    1,
    ...input.map((value, index) =>
      standardise(value, model.means[index] ?? 0, model.scales[index] ?? 1, model.zLimit),
    ),
  ];
  const dot = (weights: readonly number[]) =>
    row.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0);
  const point = { x: dot(model.weightsX), y: dot(model.weightsY) };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : undefined;
}

export function sameGeometry(a: ViewportGeometry, b: ViewportGeometry): boolean {
  return (Object.keys(a) as (keyof ViewportGeometry)[]).every(
    (key) =>
      Number.isFinite(a[key]) &&
      Number.isFinite(b[key]) &&
      Math.abs(a[key] - b[key]) < (key === 'pixelRatio' ? 1e-6 : 0.5),
  );
}

export function holdoutDiagnostics(errors: readonly number[]): {
  medianPixels: number;
  maximumPixels: number;
  points: number;
} {
  if (!errors.length || errors.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('No valid holdout measurements');
  const ordered = [...errors].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    medianPixels:
      ordered.length % 2
        ? (ordered[middle] ?? 0)
        : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2,
    maximumPixels: ordered.at(-1) ?? 0,
    points: ordered.length,
  };
}
