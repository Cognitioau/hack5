import {
  GAZE_VARIANTS,
  fitGaze,
  holdoutDiagnostics,
  predictGaze,
  type GazeModel,
  type GazeVariant,
} from './calibration';
import { median, replayTarget } from './collector';
import type { GazeDiagnostics, TargetRecord } from './diagnostics';
import {
  chooseCandidate,
  crossValidate,
  defaultCandidates,
  fitPoints,
  pixelError,
  type CalibrationPoint,
  type Candidate,
  type Viewport,
} from './selection';
import { GAZE_TUNING, type CollectionTuning } from './tuning';

export type ErrorSummary = { medianPixels: number; maximumPixels: number; points: number };
export type VariantReport = {
  variant: GazeVariant | 'legacy';
  lambda: number;
  crossValidation: { medianPixels: number; meanPixels: number; maximumPixels: number } | null;
  validation: ErrorSummary | null;
};
export type SessionReport = {
  recorded: { variant: GazeVariant; lambda: number; holdout: ErrorSummary };
  /**
   * False if replaying the recorded frames with the recorded settings did not reproduce them,
   * which means the collection code changed since recording. Variant rows always re-aggregate
   * frames with the current code.
   */
  replayMatches: boolean;
  selected: { variant: GazeVariant; lambda: number };
  variants: VariantReport[];
  /** Settling time varied with the current window length (frames after the point advanced are used). */
  settleSweep: SweepRow[];
  /** Stable-window length varied with the current settling time. */
  windowSweep: SweepRow[];
  /** Steadiness range varied with the other current settings. */
  rangeSweep: SweepRow[];
  /** How the live captures went, to place the steadiness and departure limits. */
  captures: CaptureSummary;
};
export type CaptureSummary = {
  targets: number;
  /** Captured by timeout rather than by a steady window that had left the onset position. */
  timedOut: number;
  spread: { median: number; p90: number };
  /** Null when no target had a face visible as it appeared. */
  departure: { median: number; minimum: number; belowLimit: number } | null;
};
export type SweepRow = {
  settleMs: number;
  stableSamples: number;
  stabilityRange: number;
  capturedTargets: number;
  unstableTargets: number;
  /** Null unless every calibration target was captured, so rows stay comparable. */
  selected: Candidate | null;
  validation: ErrorSummary | null;
};

const summary = (errors: readonly number[]): ErrorSummary | null =>
  errors.length && errors.every(Number.isFinite) ? holdoutDiagnostics(errors) : null;
const close = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? 0)) < 1e-9);

/**
 * Re-aggregates each target's recorded frames with the current collector. With `fallback`, a
 * target the replay cannot capture (for example frames beyond the recording cap) keeps its
 * recorded capture; without it, such a target is omitted.
 */
function points(records: readonly TargetRecord[], tuning: CollectionTuning, fallback: boolean) {
  return records.flatMap((record): CalibrationPoint[] => {
    const captured =
      replayTarget(record.samples, tuning) ?? (fallback ? record.captured : undefined);
    return captured
      ? [{ target: record.target, rows: captured.rows, features: captured.features }]
      : [];
  });
}

function validate(
  model: GazeModel | undefined,
  held: readonly CalibrationPoint[],
  viewport: Viewport,
) {
  if (!model) return null;
  const errors = held.map((point) => {
    const prediction = predictGaze(model, point.features);
    return prediction ? pixelError(prediction, point.target, viewport) : Number.POSITIVE_INFINITY;
  });
  return summary(errors);
}

const attempt = <T>(operation: () => T): T | undefined => {
  try {
    return operation();
  } catch {
    return undefined;
  }
};

/**
 * Approximates the pre-tuning lab on recorded frames: the last ≤12 frames within 1.2 s before
 * the point advanced (reset by a lost face), all ten features, λ 0.5, unweighted, unclipped.
 * People behave differently in the new flow, so this is a rough reference rather than a replay.
 */
function legacyPoint(record: TargetRecord): CalibrationPoint | undefined {
  const rows: number[][] = [];
  const last = record.samples.at(-1)?.t ?? 0;
  for (const sample of [...record.samples].reverse()) {
    if (!sample.features || last - sample.t > 1200 || rows.length === 12) break;
    rows.unshift(sample.features);
  }
  if (rows.length < 8) return undefined;
  const features = (rows[0] ?? []).map(
    (_, index) => rows.reduce((sum, row) => sum + (row[index] ?? 0), 0) / rows.length,
  );
  return { target: record.target, rows, features };
}

function legacyReport(session: GazeDiagnostics, viewport: Viewport): VariantReport {
  const calibration = session.calibration.map(legacyPoint);
  const validation = session.validation.map(legacyPoint);
  if (calibration.some((point) => !point) || validation.some((point) => !point))
    return { variant: 'legacy', lambda: 0.5, crossValidation: null, validation: null };
  const train = calibration as CalibrationPoint[];
  const fitLegacy = (subset: readonly CalibrationPoint[], minimumTargets: number) =>
    fitGaze(
      subset.flatMap((point) =>
        point.rows.map((row) => ({ features: [...row], target: point.target })),
      ),
      0.5,
      {
        variant: 'full',
        minimumTargets,
        zLimit: Number.POSITIVE_INFINITY,
        equalTargetWeights: false,
      },
    );
  const folds = train.map((held, index) => {
    const model = attempt(() =>
      fitLegacy(
        train.filter((_, other) => other !== index),
        train.length - 1,
      ),
    );
    const prediction = model && predictGaze(model, held.features);
    return prediction ? pixelError(prediction, held.target, viewport) : Number.POSITIVE_INFINITY;
  });
  return {
    variant: 'legacy',
    lambda: 0.5,
    crossValidation: {
      medianPixels: median(folds),
      meanPixels: folds.reduce((sum, value) => sum + value, 0) / folds.length,
      maximumPixels: Math.max(...folds),
    },
    validation: validate(
      attempt(() => fitLegacy(train, train.length)),
      validation as CalibrationPoint[],
      viewport,
    ),
  };
}

export const SETTLE_SWEEP_MS = [0, 200, 350, 500, 700, 1000] as const;
export const WINDOW_SWEEP_SAMPLES = [5, 8, 10, 12, 15] as const;
export const RANGE_SWEEP = [0.015, 0.02, 0.03, 0.045, 0.06] as const;

const at = (values: readonly number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(fraction * ordered.length))] ?? Number.NaN;
};
function captureSummary(session: GazeDiagnostics): CaptureSummary {
  const captured = [...session.calibration, ...session.validation].map((record) => record.captured);
  const departures = captured.flatMap((capture) =>
    capture.departure === null ? [] : [capture.departure],
  );
  const spreads = captured.map((capture) => capture.spread);
  return {
    targets: captured.length,
    timedOut: captured.filter((capture) => !capture.stable).length,
    spread: { median: median(spreads), p90: at(spreads, 0.9) },
    departure: departures.length
      ? {
          median: median(departures),
          minimum: Math.min(...departures),
          belowLimit: departures.filter((value) => value < session.tuning.collection.departureMin)
            .length,
        }
      : null,
  };
}

function sweep(
  session: GazeDiagnostics,
  tuning: CollectionTuning,
  viewport: Viewport,
  lambdas: readonly number[],
): SweepRow {
  const captures = [...session.calibration, ...session.validation].map((record) =>
    replayTarget(record.samples, tuning),
  );
  const train = points(session.calibration, tuning, false);
  const held = points(session.validation, tuning, false);
  const result =
    train.length === session.calibration.length
      ? attempt(() => {
          const choice = chooseCandidate(
            crossValidate(train, viewport, defaultCandidates(GAZE_VARIANTS, lambdas)),
          );
          return { choice, model: fitPoints(train, choice, train.length) };
        })
      : undefined;
  return {
    settleMs: tuning.settleMs,
    stableSamples: tuning.stableSamples,
    stabilityRange: tuning.stabilityRange,
    capturedTargets: captures.filter(Boolean).length,
    unstableTargets: captures.filter((captured) => captured && !captured.stable).length,
    selected: result ? { variant: result.choice.variant, lambda: result.choice.lambda } : null,
    validation:
      result && held.length === session.validation.length
        ? validate(result.model, held, viewport)
        : null,
  };
}

/** Re-runs model selection and every variant on one exported session using the current code. */
export function evaluateSession(
  session: GazeDiagnostics,
  options: { lambdas?: readonly number[]; settleSweepMs?: readonly number[] } = {},
): SessionReport {
  const viewport = { width: session.viewport.width, height: session.viewport.height };
  const lambdas = options.lambdas ?? GAZE_TUNING.model.lambdaGrid;
  const current = { ...GAZE_TUNING.collection, maxRecordedSamples: 0 };
  const calibration = points(session.calibration, current, true);
  const validation = points(session.validation, current, true);
  const replayMatches = [...session.calibration, ...session.validation].every((record) => {
    const replayed = replayTarget(record.samples, session.tuning.collection);
    return !!replayed && close(replayed.features, record.captured.features);
  });
  const table = crossValidate(calibration, viewport, defaultCandidates(GAZE_VARIANTS, lambdas));
  const selected = chooseCandidate(table);
  const variants: VariantReport[] = GAZE_VARIANTS.map((variant) => {
    const scores = table.filter((score) => score.variant === variant);
    const chosen = attempt(() => chooseCandidate(scores));
    if (!chosen) return { variant, lambda: Number.NaN, crossValidation: null, validation: null };
    return {
      variant,
      lambda: chosen.lambda,
      crossValidation: {
        medianPixels: chosen.medianPixels,
        meanPixels: chosen.meanPixels,
        maximumPixels: chosen.maximumPixels,
      },
      validation: validate(
        attempt(() => fitPoints(calibration, chosen, calibration.length)),
        validation,
        viewport,
      ),
    };
  });
  variants.push(legacyReport(session, viewport));
  const settleSweep = (options.settleSweepMs ?? SETTLE_SWEEP_MS).map((settleMs) =>
    sweep(session, { ...current, settleMs }, viewport, lambdas),
  );
  const windowSweep = WINDOW_SWEEP_SAMPLES.map((stableSamples) =>
    sweep(session, { ...current, stableSamples }, viewport, lambdas),
  );
  const rangeSweep = RANGE_SWEEP.map((stabilityRange) =>
    sweep(session, { ...current, stabilityRange }, viewport, lambdas),
  );
  return {
    recorded: {
      variant: session.model.variant,
      lambda: session.model.lambda,
      holdout: session.holdout,
    },
    replayMatches,
    selected: { variant: selected.variant, lambda: selected.lambda },
    variants,
    settleSweep,
    windowSweep,
    rangeSweep,
    captures: captureSummary(session),
  };
}
