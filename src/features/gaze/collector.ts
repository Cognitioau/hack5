import { GAZE_TUNING, type CollectionTuning } from './tuning';

/** Iris-in-eye features (left/right horizontal and vertical). Stability is judged on these. */
export const IRIS_FEATURES = [0, 1, 2, 3] as const;

/** One processed frame: milliseconds since the target appeared, and geometric features or none. */
export type FeatureSample = { t: number; features: number[] | null };
export type CapturedTarget = {
  /**
   * Per-feature mean of the inlier frames. Outliers are already rejected, and the mean uses the
   * remaining frames more efficiently than a median (about 1.5× less noise over eight frames).
   */
  features: number[];
  /** Inlier frames used for training. */
  rows: number[][];
  /** Times of the inlier frames, relative to the target appearing. */
  usedTimes: number[];
  /** Largest iris-feature median absolute deviation in the captured window. */
  spread: number;
  /** False when the window was captured by timeout rather than by meeting the stability limit. */
  stable: boolean;
  capturedAt: number;
};
export type CollectionState =
  | { phase: 'settling' | 'collecting'; progress: number }
  | { phase: 'captured'; progress: 1; captured: CapturedTarget };

export const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? (ordered[middle] ?? Number.NaN)
    : ((ordered[middle - 1] ?? Number.NaN) + (ordered[middle] ?? Number.NaN)) / 2;
};
const column = (rows: readonly (readonly number[])[], index: number) =>
  rows.map((row) => row[index] ?? Number.NaN);
const deviation = (values: readonly number[]) => {
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
};
const stabilityIndices = (dimensions: number) =>
  dimensions >= IRIS_FEATURES.length
    ? [...IRIS_FEATURES]
    : Array.from({ length: dimensions }, (_, index) => index);

/** Largest median absolute deviation across the iris features of a window of frames. */
export function windowSpread(rows: readonly (readonly number[])[]): number {
  if (!rows.length) return Number.POSITIVE_INFINITY;
  return Math.max(
    ...stabilityIndices(rows[0]?.length ?? 0).map((index) => deviation(column(rows, index))),
  );
}

/** Rejects frames far from the window median on any iris feature; keeps at least half. */
export function rejectOutliers(
  rows: readonly (readonly number[])[],
  tuning: Pick<CollectionTuning, 'outlierZ' | 'madFloor'> = GAZE_TUNING.collection,
): number[] {
  const indices = stabilityIndices(rows[0]?.length ?? 0);
  const centres = indices.map((index) => median(column(rows, index)));
  const scales = indices.map(
    (index) => 1.4826 * Math.max(tuning.madFloor, deviation(column(rows, index))),
  );
  const kept = rows.flatMap((row, position) =>
    indices.every(
      (index, k) =>
        Math.abs((row[index] ?? Number.NaN) - (centres[k] ?? 0)) / (scales[k] ?? 1) <=
        tuning.outlierZ,
    )
      ? [position]
      : [],
  );
  return kept.length * 2 >= rows.length ? kept : rows.map((_, position) => position);
}

/**
 * Collects one target's frames: drops the settling period, waits for a stable window, then
 * captures it and stops changing, so later reading or cursor movement cannot contaminate it.
 */
export class TargetCollector {
  private readonly recorded: FeatureSample[] = [];
  private window: { t: number; features: number[] }[] = [];
  private lastSeen: number | undefined;
  private captured: CapturedTarget | undefined;

  constructor(private readonly tuning: CollectionTuning = GAZE_TUNING.collection) {}

  get samples(): readonly FeatureSample[] {
    return this.recorded;
  }

  get result(): CapturedTarget | undefined {
    return this.captured;
  }

  add(t: number, input: readonly number[] | undefined): CollectionState {
    const features = input?.every(Number.isFinite) ? input : undefined;
    if (this.recorded.length < this.tuning.maxRecordedSamples)
      this.recorded.push({ t, features: features ? [...features] : null });
    if (this.captured) return { phase: 'captured', progress: 1, captured: this.captured };
    if (!features) {
      if (this.lastSeen !== undefined && t - this.lastSeen > this.tuning.lostResetMs)
        this.window = [];
      return this.state(t);
    }
    this.lastSeen = t;
    if (t < this.tuning.settleMs) return this.state(t);
    this.window.push({ t, features: [...features] });
    this.window = this.window.slice(-this.tuning.stableSamples);
    if (this.window.length < this.tuning.stableSamples) return this.state(t);
    const rows = this.window.map((sample) => sample.features);
    const spread = windowSpread(rows);
    const stable = spread <= this.tuning.stabilityMad;
    if (!stable && t - this.tuning.settleMs < this.tuning.stabilityTimeoutMs) return this.state(t);
    const kept = rejectOutliers(rows, this.tuning);
    const inliers = kept.map((index) => rows[index] ?? []);
    this.captured = {
      features: Array.from(
        { length: rows[0]?.length ?? 0 },
        (_, index) =>
          column(inliers, index).reduce((sum, value) => sum + value, 0) / inliers.length,
      ),
      rows: inliers,
      usedTimes: kept.map((index) => this.window[index]?.t ?? Number.NaN),
      spread,
      stable,
      capturedAt: t,
    };
    return { phase: 'captured', progress: 1, captured: this.captured };
  }

  private state(t: number): CollectionState {
    return t < this.tuning.settleMs
      ? { phase: 'settling', progress: 0 }
      : { phase: 'collecting', progress: this.window.length / this.tuning.stableSamples };
  }
}

/** Replays recorded frames through the same collector, for offline tuning of these constants. */
export function replayTarget(
  samples: readonly FeatureSample[],
  tuning: CollectionTuning = GAZE_TUNING.collection,
): CapturedTarget | undefined {
  const collector = new TargetCollector({ ...tuning, maxRecordedSamples: 0 });
  for (const sample of samples) collector.add(sample.t, sample.features ?? undefined);
  return collector.result;
}
