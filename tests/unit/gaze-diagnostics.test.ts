import { describe, expect, it } from 'vitest';
import {
  FEATURE_NAMES,
  holdoutDiagnostics,
  predictGaze,
} from '../../src/features/gaze/calibration';
import {
  GAZE_DIAGNOSTICS_SCHEMA,
  JitterTracker,
  buildDiagnostics,
  parseDiagnostics,
} from '../../src/features/gaze/diagnostics';
import { evaluateSession } from '../../src/features/gaze/evaluate';
import { headDeviation, headReference } from '../../src/features/gaze/movement';
import { pixelError, selectGazeModel } from '../../src/features/gaze/selection';
import {
  calibrationTargets,
  random,
  simulateRecords,
  validationTargets,
} from './helpers/gaze-synthetic';

const viewport = {
  width: 1280,
  height: 720,
  screenX: 0,
  screenY: 25,
  outerWidth: 1280,
  outerHeight: 800,
  pixelRatio: 2,
};

function exportSession(seed = 21) {
  const rng = random(seed);
  // Ten frames after capture leave the approximate legacy reference enough frames to compare.
  const calibration = simulateRecords(calibrationTargets, rng, { extraFrames: 10 });
  const selection = selectGazeModel(
    calibration.map((record) => ({ target: record.target, ...record.captured })),
    viewport,
  );
  const reference = headReference(calibration.flatMap((record) => record.captured.rows));
  const validation = simulateRecords(validationTargets, rng, { extraFrames: 10 }).map((record) => {
    const prediction = predictGaze(selection.model, record.captured.features) ?? { x: 0, y: 0 };
    return {
      ...record,
      prediction,
      errorPixels: pixelError(prediction, record.target, viewport),
      movement: reference ? (headDeviation(reference, record.captured.features) ?? null) : null,
    };
  });
  const jitter = new JitterTracker();
  for (let frame = 0; frame < 30; frame++)
    jitter.add({ x: 600 + (frame % 2) * 40, y: 300 }, { x: 610, y: 300 + frame }, frame * 80, true);
  return {
    selection,
    file: buildDiagnostics({
      createdAt: '2026-10-20T00:00:00.000Z',
      extensionVersion: '0.2.0',
      viewport,
      calibration,
      validation,
      selection,
      holdout: holdoutDiagnostics(validation.map((record) => record.errorPixels)),
      live: jitter.summary(),
    }),
  };
}

/** Every key, and a count of numeric arrays longer than one feature vector or x/y/z points. */
function inspect(value: unknown, found = { keys: new Set<string>(), suspicious: 0 }) {
  if (Array.isArray(value)) {
    if (value.length > FEATURE_NAMES.length && value.some((item) => typeof item === 'number'))
      found.suspicious++;
    for (const item of value) inspect(item, found);
  } else if (value && typeof value === 'object') {
    if (['x', 'y', 'z'].every((key) => key in value)) found.suspicious++;
    for (const [key, item] of Object.entries(value)) {
      found.keys.add(key);
      inspect(item, found);
    }
  }
  return found;
}

describe('explicit session diagnostics export and offline evaluation', () => {
  it('contains only documented derived values, never images or landmark arrays', () => {
    const { file } = exportSession();
    const json = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      [
        'calibration',
        'contents',
        'createdAt',
        'extensionVersion',
        'featureNames',
        'holdout',
        'live',
        'model',
        'schema',
        'tuning',
        'validation',
        'version',
        'viewport',
      ].sort(),
    );
    const found = inspect(json);
    expect(
      [...found.keys].filter((key) => /landmark|image|frame|video|mesh|blob|base64/i.test(key)),
    ).toEqual([]);
    expect(found.suspicious).toBe(0);
    expect(JSON.stringify(json)).not.toMatch(/data:|base64/);
    for (const record of [...file.calibration, ...file.validation])
      for (const sample of record.samples)
        expect(sample.features === null || sample.features.length === FEATURE_NAMES.length).toBe(
          true,
        );
    expect(file.live?.raw.medianStepPixels).toBe(40);
    expect(file.live?.smoothed.medianStepPixels).toBeCloseTo(1, 6);
    expect(file.model.crossValidation).toHaveLength(24);
  });

  it('round-trips through validation and is rejected when malformed', () => {
    const { file } = exportSession();
    const parsed = parseDiagnostics(JSON.parse(JSON.stringify(file)));
    expect(parsed.calibration).toHaveLength(9);
    expect(parsed.validation[2]?.captured.rows).toEqual(file.validation[2]?.captured.rows);
    expect(() => parseDiagnostics({ ...file, schema: 'other' })).toThrow('$.schema');
    expect(() =>
      parseDiagnostics({
        ...file,
        calibration: [{ ...file.calibration[0], captured: { features: [1, 2, 3] } }],
      }),
    ).toThrow('captured.features');
    expect(() => parseDiagnostics(null)).toThrow();
    expect(GAZE_DIAGNOSTICS_SCHEMA).toBe(parsed.schema);
  });

  it('re-evaluates every variant, reproduces the live capture, and sweeps settling offline', () => {
    const { file, selection } = exportSession();
    const report = evaluateSession(parseDiagnostics(JSON.parse(JSON.stringify(file))));
    expect(report.replayMatches).toBe(true);
    expect(report.selected).toEqual({
      variant: selection.chosen.variant,
      lambda: selection.chosen.lambda,
    });
    expect(report.variants.map((row) => row.variant)).toEqual([
      'iris',
      'iris-quadratic',
      'iris-head',
      'full',
      'legacy',
    ]);
    const chosen = report.variants.find((row) => row.variant === selection.chosen.variant);
    expect(chosen?.validation?.medianPixels).toBeCloseTo(file.holdout.medianPixels, 6);
    expect(report.variants.every((row) => row.crossValidation && row.validation)).toBe(true);
    expect(report.windowSweep.map((row) => row.stableSamples)).toEqual([5, 8, 10, 12, 15]);
    expect(
      report.windowSweep.find((row) => row.stableSamples === 8)?.validation?.medianPixels,
    ).toBeCloseTo(file.holdout.medianPixels, 6);
    const sweep = new Map(report.settleSweep.map((row) => [row.settleMs, row]));
    expect(sweep.get(350)?.validation?.medianPixels).toBeCloseTo(file.holdout.medianPixels, 6);
    // Without settling, the reaction period leaks into some captures and the checks get worse.
    expect(sweep.get(0)?.validation?.medianPixels ?? 0).toBeGreaterThan(
      sweep.get(350)?.validation?.medianPixels ?? Infinity,
    );
  });
});
