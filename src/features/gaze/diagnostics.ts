import {
  FEATURE_NAMES,
  GAZE_VARIANTS,
  type GazeVariant,
  type ViewportGeometry,
} from './calibration';
import { median, type CapturedTarget, type FeatureSample } from './collector';
import type { HeadDeviation } from './movement';
import type { CandidateScore, Selection } from './selection';
import {
  GAZE_TUNING,
  type CollectionTuning,
  type MovementTuning,
  type SmoothingTuning,
} from './tuning';

export const GAZE_DIAGNOSTICS_SCHEMA = 'zombie-hand.gaze-diagnostics';
export const GAZE_DIAGNOSTICS_VERSION = 1;
export const GAZE_DIAGNOSTICS_CONTENTS =
  'Viewport geometry, target positions, the ten derived geometric eye measurements for each processed camera frame during calibration and checks, the model choice and its cross-validation table, check errors and live-dot movement statistics. No camera images, video frames or face-mesh landmark arrays.';

type Point = { x: number; y: number };
export type TargetRecord = {
  index: number;
  target: Point;
  samples: FeatureSample[];
  captured: Omit<CapturedTarget, 'rows'> & { rows: number[][] };
};
export type ValidationRecord = TargetRecord & {
  prediction: Point;
  errorPixels: number;
  movement: HeadDeviation | null;
};
export type StepStatistics = {
  steps: number;
  medianStepPixels: number | null;
  p90StepPixels: number | null;
};
export type DiagnosticsTuning = {
  collection: CollectionTuning;
  model: { lambdaGrid: number[]; simplicityMargin: number; zLimit: number };
  smoothing: SmoothingTuning;
  movement: MovementTuning;
};
const currentTuning = (): DiagnosticsTuning => ({
  collection: { ...GAZE_TUNING.collection },
  model: { ...GAZE_TUNING.model, lambdaGrid: [...GAZE_TUNING.model.lambdaGrid] },
  smoothing: { ...GAZE_TUNING.smoothing },
  movement: { ...GAZE_TUNING.movement },
});
export type LiveStatistics = {
  durationMs: number;
  /** Processed camera updates in the live phase, by outcome. */
  counts: {
    updates: number;
    predicted: number;
    lostFace: number;
    moved: number;
    outsideViewport: number;
  };
  raw: StepStatistics;
  smoothed: StepStatistics;
};
export type GazeDiagnostics = {
  schema: typeof GAZE_DIAGNOSTICS_SCHEMA;
  version: typeof GAZE_DIAGNOSTICS_VERSION;
  createdAt: string;
  extensionVersion: string | null;
  contents: string;
  viewport: ViewportGeometry;
  tuning: DiagnosticsTuning;
  featureNames: readonly string[];
  calibration: TargetRecord[];
  validation: ValidationRecord[];
  model: { variant: GazeVariant; lambda: number; crossValidation: CandidateScore[] };
  holdout: { medianPixels: number; maximumPixels: number; points: number };
  live: LiveStatistics | null;
};

const quantile = (values: readonly number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(fraction * ordered.length))] ?? null;
};
const stepStatistics = (steps: readonly number[]): StepStatistics => ({
  steps: steps.length,
  medianStepPixels: steps.length ? median(steps) : null,
  p90StepPixels: quantile(steps, 0.9),
});

/**
 * Frame-to-frame movement of the raw and smoothed live estimate. The median step is robust to
 * the occasional intended saccade, so during steady looking it approximates jitter.
 */
export class JitterTracker {
  private readonly raw: number[] = [];
  private readonly smoothed: number[] = [];
  private previous: { raw: Point; smoothed: Point; timestamp: number } | undefined;
  private first: number | undefined;
  private last: number | undefined;
  private counts = { updates: 0, predicted: 0, lost: 0, moved: 0, outside: 0 };

  constructor(
    private readonly gapMs: number = GAZE_TUNING.smoothing.resetGapMs,
    private readonly limit = 4000,
  ) {}

  private tick(timestamp: number) {
    this.first ??= timestamp;
    this.last = timestamp;
    this.counts.updates++;
  }

  interrupt(kind: 'lost' | 'moved', timestamp: number): void {
    this.tick(timestamp);
    this.counts[kind]++;
    this.previous = undefined;
  }

  add(raw: Point, smoothed: Point, timestamp: number, inside: boolean): void {
    this.tick(timestamp);
    this.counts.predicted++;
    if (!inside) this.counts.outside++;
    const previous = this.previous;
    if (previous && timestamp - previous.timestamp <= this.gapMs && this.raw.length < this.limit) {
      this.raw.push(Math.hypot(raw.x - previous.raw.x, raw.y - previous.raw.y));
      this.smoothed.push(
        Math.hypot(smoothed.x - previous.smoothed.x, smoothed.y - previous.smoothed.y),
      );
    }
    this.previous = { raw, smoothed, timestamp };
  }

  summary(): LiveStatistics | null {
    if (this.first === undefined || this.last === undefined) return null;
    return {
      durationMs: this.last - this.first,
      counts: {
        updates: this.counts.updates,
        predicted: this.counts.predicted,
        lostFace: this.counts.lost,
        moved: this.counts.moved,
        outsideViewport: this.counts.outside,
      },
      raw: stepStatistics(this.raw),
      smoothed: stepStatistics(this.smoothed),
    };
  }
}

export function buildDiagnostics(input: {
  createdAt: string;
  extensionVersion: string | null;
  viewport: ViewportGeometry;
  calibration: readonly TargetRecord[];
  validation: readonly ValidationRecord[];
  selection: Pick<Selection, 'chosen' | 'table'>;
  holdout: GazeDiagnostics['holdout'];
  live: LiveStatistics | null;
}): GazeDiagnostics {
  // Copy field by field so nothing beyond the documented contents can reach the file.
  const target = (record: TargetRecord): TargetRecord => ({
    index: record.index,
    target: { x: record.target.x, y: record.target.y },
    samples: record.samples.map((sample) => ({
      t: sample.t,
      features: sample.features ? [...sample.features] : null,
    })),
    captured: {
      features: [...record.captured.features],
      rows: record.captured.rows.map((row) => [...row]),
      usedTimes: [...record.captured.usedTimes],
      spread: record.captured.spread,
      stable: record.captured.stable,
      capturedAt: record.captured.capturedAt,
    },
  });
  return {
    schema: GAZE_DIAGNOSTICS_SCHEMA,
    version: GAZE_DIAGNOSTICS_VERSION,
    createdAt: input.createdAt,
    extensionVersion: input.extensionVersion,
    contents: GAZE_DIAGNOSTICS_CONTENTS,
    viewport: { ...input.viewport },
    tuning: currentTuning(),
    featureNames: [...FEATURE_NAMES],
    calibration: input.calibration.map(target),
    validation: input.validation.map((record) => ({
      ...target(record),
      prediction: { x: record.prediction.x, y: record.prediction.y },
      errorPixels: record.errorPixels,
      movement: record.movement
        ? {
            distanceRatio: record.movement.distanceRatio,
            centreShift: record.movement.centreShift,
          }
        : null,
    })),
    model: {
      variant: input.selection.chosen.variant,
      lambda: input.selection.chosen.lambda,
      crossValidation: input.selection.table.map((score) => ({ ...score })),
    },
    holdout: { ...input.holdout },
    live: input.live,
  };
}

const fail = (path: string): never => {
  throw new Error(`Invalid gaze diagnostics at ${path}`);
};
const record = (value: unknown, path: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(path);
const finite = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(path);
const unit = (value: unknown, path: string): number => {
  const number = finite(value, path);
  return number >= 0 && number <= 1 ? number : fail(path);
};
const vector = (value: unknown, path: string): number[] =>
  Array.isArray(value) && value.length === FEATURE_NAMES.length
    ? value.map((item, index) => finite(item, `${path}[${index}]`))
    : fail(path);
const list = (value: unknown, path: string, maximum: number): unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail(path);

function parseTarget(value: unknown, path: string): TargetRecord {
  const item = record(value, path);
  const point = record(item.target, `${path}.target`);
  const captured = record(item.captured, `${path}.captured`);
  return {
    index: finite(item.index, `${path}.index`),
    target: { x: unit(point.x, `${path}.target.x`), y: unit(point.y, `${path}.target.y`) },
    samples: list(item.samples, `${path}.samples`, 1000).map((entry, index) => {
      const sample = record(entry, `${path}.samples[${index}]`);
      return {
        t: finite(sample.t, `${path}.samples[${index}].t`),
        features:
          sample.features === null
            ? null
            : vector(sample.features, `${path}.samples[${index}].features`),
      };
    }),
    captured: {
      features: vector(captured.features, `${path}.captured.features`),
      rows: list(captured.rows, `${path}.captured.rows`, 1000).map((row, index) =>
        vector(row, `${path}.captured.rows[${index}]`),
      ),
      usedTimes: list(captured.usedTimes, `${path}.captured.usedTimes`, 1000).map((time, index) =>
        finite(time, `${path}.captured.usedTimes[${index}]`),
      ),
      spread: finite(captured.spread, `${path}.captured.spread`),
      stable: typeof captured.stable === 'boolean' ? captured.stable : fail(`${path}.stable`),
      capturedAt: finite(captured.capturedAt, `${path}.captured.capturedAt`),
    },
  };
}

function parseTuning(value: unknown): DiagnosticsTuning {
  const tuning = record(value, '$.tuning');
  const group = <T extends Record<string, number>>(name: string, defaults: T): T => {
    const section = record(tuning[name], `$.tuning.${name}`);
    return Object.fromEntries(
      Object.keys(defaults).map((key) => [key, finite(section[key], `$.tuning.${name}.${key}`)]),
    ) as T;
  };
  const current = currentTuning();
  const model = record(tuning.model, '$.tuning.model');
  return {
    collection: group('collection', current.collection),
    model: {
      lambdaGrid: list(model.lambdaGrid, '$.tuning.model.lambdaGrid', 32).map((item, index) =>
        finite(item, `$.tuning.model.lambdaGrid[${index}]`),
      ),
      simplicityMargin: finite(model.simplicityMargin, '$.tuning.model.simplicityMargin'),
      zLimit: finite(model.zLimit, '$.tuning.model.zLimit'),
    },
    smoothing: group('smoothing', current.smoothing),
    movement: group('movement', current.movement),
  };
}

/** Runtime validation for files given to the offline evaluator. Unknown extra fields are ignored. */
export function parseDiagnostics(value: unknown): GazeDiagnostics {
  const root = record(value, '$');
  if (root.schema !== GAZE_DIAGNOSTICS_SCHEMA) fail('$.schema');
  if (root.version !== GAZE_DIAGNOSTICS_VERSION) fail('$.version');
  const viewport = record(root.viewport, '$.viewport');
  const geometry = Object.fromEntries(
    (
      ['width', 'height', 'screenX', 'screenY', 'outerWidth', 'outerHeight', 'pixelRatio'] as const
    ).map((key) => [key, finite(viewport[key], `$.viewport.${key}`)]),
  ) as ViewportGeometry;
  if (!(geometry.width > 0 && geometry.height > 0)) fail('$.viewport');
  const model = record(root.model, '$.model');
  const variant = GAZE_VARIANTS.find((candidate) => candidate === model.variant);
  if (!variant) fail('$.model.variant');
  const holdout = record(root.holdout, '$.holdout');
  return {
    schema: GAZE_DIAGNOSTICS_SCHEMA,
    version: GAZE_DIAGNOSTICS_VERSION,
    createdAt: typeof root.createdAt === 'string' ? root.createdAt : fail('$.createdAt'),
    extensionVersion: typeof root.extensionVersion === 'string' ? root.extensionVersion : null,
    contents: GAZE_DIAGNOSTICS_CONTENTS,
    viewport: geometry,
    tuning: parseTuning(root.tuning),
    featureNames: [...FEATURE_NAMES],
    calibration: list(root.calibration, '$.calibration', 64).map((item, index) =>
      parseTarget(item, `$.calibration[${index}]`),
    ),
    validation: list(root.validation, '$.validation', 64).map((item, index) => {
      const target = parseTarget(item, `$.validation[${index}]`);
      const entry = record(item, `$.validation[${index}]`);
      const prediction = record(entry.prediction, `$.validation[${index}].prediction`);
      return {
        ...target,
        prediction: {
          x: finite(prediction.x, `$.validation[${index}].prediction.x`),
          y: finite(prediction.y, `$.validation[${index}].prediction.y`),
        },
        errorPixels: finite(entry.errorPixels, `$.validation[${index}].errorPixels`),
        movement: null,
      };
    }),
    model: {
      variant: variant ?? 'full',
      lambda: finite(model.lambda, '$.model.lambda'),
      crossValidation: [],
    },
    holdout: {
      medianPixels: finite(holdout.medianPixels, '$.holdout.medianPixels'),
      maximumPixels: finite(holdout.maximumPixels, '$.holdout.maximumPixels'),
      points: finite(holdout.points, '$.holdout.points'),
    },
    live: null,
  };
}
