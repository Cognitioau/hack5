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
import { GAZE_TUNING } from '../../src/features/gaze/tuning';
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

const fail = (): never => {
  throw new Error('Expected a value');
};

/** Every leaf path in a value, with array positions collapsed to []. */
function leafPaths(value: unknown, path = '', found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) leafPaths(item, `${path}[]`, found);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      leafPaths(item, path ? `${path}.${key}` : key, found);
  else found.add(path);
  return found;
}

describe('explicit session diagnostics export and offline evaluation', () => {
  it('copies only documented fields even when its inputs carry extra ones', () => {
    // Stand-in for any future field on these objects (a landmark array, say): it must not leak.
    const leak = <T extends object>(value: T): T => Object.assign({ leak: [0.5, 0.5, 0] }, value);
    const { file, selection } = exportSession();
    const live = file.live ?? fail();
    const leaky = buildDiagnostics({
      createdAt: file.createdAt,
      extensionVersion: file.extensionVersion,
      viewport: leak(file.viewport),
      calibration: file.calibration.map((record) =>
        leak({
          ...record,
          target: leak(record.target),
          samples: record.samples.map(leak),
          captured: leak(record.captured),
        }),
      ),
      validation: file.validation.map((record) =>
        leak({
          ...record,
          prediction: leak(record.prediction),
          movement: record.movement && leak(record.movement),
        }),
      ),
      selection: { chosen: leak(selection.chosen), table: selection.table.map(leak) },
      holdout: leak(file.holdout),
      live: leak({
        ...live,
        counts: leak(live.counts),
        raw: leak(live.raw),
        smoothed: leak(live.smoothed),
      }),
    });
    expect(JSON.stringify(leaky)).not.toContain('leak');
    expect(JSON.parse(JSON.stringify(leaky))).toEqual(JSON.parse(JSON.stringify(file)));
  });

  it('holds exactly the documented fields', () => {
    // A new field must be added here and described in GAZE_DIAGNOSTICS_CONTENTS, the gaze.html
    // hint and docs/PRIVACY.md in the same change.
    const { file } = exportSession();
    const target = [
      'captured.capturedAt',
      'captured.departure',
      'captured.features[]',
      'captured.rows[][]',
      'captured.spread',
      'captured.stable',
      'captured.usedTimes[]',
      'index',
      'samples[].features', // null: no face or open eyes measurable in that frame
      'samples[].features[]',
      'samples[].t',
      'target.x',
      'target.y',
    ];
    const check = [
      'errorPixels',
      'movement.centreShift',
      'movement.distanceRatio',
      'prediction.x',
      'prediction.y',
    ];
    const tuning = Object.entries(GAZE_TUNING).flatMap(([group, values]) =>
      Object.entries(values).map(([key, value]) =>
        Array.isArray(value) ? `tuning.${group}.${key}[]` : `tuning.${group}.${key}`,
      ),
    );
    const steps = ['medianStepPixels', 'p90StepPixels', 'steps'];
    const documented = [
      'schema',
      'version',
      'createdAt',
      'extensionVersion',
      'contents',
      'featureNames[]',
      ...['width', 'height', 'screenX', 'screenY', 'outerWidth', 'outerHeight', 'pixelRatio'].map(
        (key) => `viewport.${key}`,
      ),
      ...tuning,
      ...target.map((path) => `calibration[].${path}`),
      ...[...target, ...check].map((path) => `validation[].${path}`),
      'model.variant',
      'model.lambda',
      ...['variant', 'lambda', 'medianPixels', 'meanPixels', 'maximumPixels'].map(
        (key) => `model.crossValidation[].${key}`,
      ),
      'holdout.medianPixels',
      'holdout.maximumPixels',
      'holdout.points',
      'live.durationMs',
      ...['updates', 'predicted', 'lostFace', 'moved', 'outsideViewport'].map(
        (key) => `live.counts.${key}`,
      ),
      ...steps.map((key) => `live.raw.${key}`),
      ...steps.map((key) => `live.smoothed.${key}`),
    ];
    expect([...leafPaths(JSON.parse(JSON.stringify(file)))].sort()).toEqual(documented.sort());
  });

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
    // Files saved before the product was named Zombie Brain carry this schema, and still read.
    expect(parseDiagnostics({ ...file, schema: 'zombie-hand.gaze-diagnostics' }).schema).toBe(
      'zombie-hand.gaze-diagnostics',
    );
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
    // The steadiness range keeps reaction-period frames out on its own: with no settling at all
    // the checks stay close (under a median absolute deviation they rose past 100 px).
    expect(sweep.get(0)?.validation?.medianPixels ?? Infinity).toBeLessThan(
      2 * (sweep.get(350)?.validation?.medianPixels ?? 0),
    );
    expect(report.rangeSweep.map((row) => row.stabilityRange)).toEqual([
      0.015, 0.02, 0.03, 0.045, 0.06,
    ]);
    expect(
      report.rangeSweep.find((row) => row.stabilityRange === 0.03)?.validation?.medianPixels,
    ).toBeCloseTo(file.holdout.medianPixels, 6);
    expect(report.captures.targets).toBe(14);
    expect(report.captures.timedOut).toBe(0);
    expect(report.captures.departure?.belowLimit).toBe(0);
  });
});
