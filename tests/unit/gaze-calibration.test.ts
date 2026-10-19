import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_TARGETS,
  eyeFeatures,
  fitGaze,
  predictGaze,
  sameGeometry,
  holdoutDiagnostics,
  type Landmark,
  type ViewportGeometry,
} from '../../src/features/gaze/calibration';

describe('gaze calibration mathematics and geometry gates', () => {
  it('fits an independent held-out synthetic mapping without presenting it as camera accuracy', () => {
    const samples = CALIBRATION_TARGETS.map((target) => ({
      features: [target.x * 2 - 1, target.y * 2 - 1],
      target,
    }));
    const model = fitGaze(samples, 0.001);
    const predicted = predictGaze(model, [-0.4, 0.2]);
    expect(predicted?.x).toBeCloseTo(0.3, 3);
    expect(predicted?.y).toBeCloseTo(0.6, 3);
    expect(predictGaze(model, [Number.NaN, 0])).toBeUndefined();
    expect(predictGaze(model, [0])).toBeUndefined();
  });
  it('rejects insufficient or malformed calibration rather than inventing predictions', () => {
    expect(() => fitGaze([])).toThrow();
    expect(() =>
      fitGaze(Array.from({ length: 9 }, () => ({ features: [1, 2], target: { x: 0.5, y: 0.5 } }))),
    ).toThrow('distinct targets');
    expect(() =>
      fitGaze(CALIBRATION_TARGETS.map((target) => ({ features: [Number.NaN], target }))),
    ).toThrow('Invalid');
  });
  it('invalidates window movement, resizing and zoom/device scaling', () => {
    const geometry: ViewportGeometry = {
      width: 1280,
      height: 720,
      screenX: 20,
      screenY: 30,
      outerWidth: 1280,
      outerHeight: 800,
      pixelRatio: 2,
    };
    expect(sameGeometry(geometry, { ...geometry })).toBe(true);
    for (const change of [
      { screenX: 21 },
      { width: 1270 },
      { outerHeight: 850 },
      { pixelRatio: 2.25 },
      { screenY: Number.NaN },
    ]) {
      expect(sameGeometry(geometry, { ...geometry, ...change })).toBe(false);
    }
  });
  it('reports measured holdout distances and handles even sample counts correctly', () => {
    expect(holdoutDiagnostics([100, 10, 40, 30])).toEqual({
      medianPixels: 35,
      maximumPixels: 100,
      points: 4,
    });
    expect(() => holdoutDiagnostics([])).toThrow();
  });
  it('requires full finite landmarks and rejects closed eyes', () => {
    expect(eyeFeatures([])).toBeUndefined();
    const points: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    Object.assign(points, {
      33: { x: 0.2, y: 0.4, z: 0 },
      133: { x: 0.4, y: 0.4, z: 0 },
      159: { x: 0.3, y: 0.38, z: 0 },
      145: { x: 0.3, y: 0.42, z: 0 },
      468: { x: 0.3, y: 0.4, z: 0 },
      362: { x: 0.6, y: 0.4, z: 0 },
      263: { x: 0.8, y: 0.4, z: 0 },
      386: { x: 0.7, y: 0.38, z: 0 },
      374: { x: 0.7, y: 0.42, z: 0 },
      473: { x: 0.7, y: 0.4, z: 0 },
    });
    expect(eyeFeatures(points)).toHaveLength(10);
    points[145] = { x: 0.3, y: 0.38, z: 0 };
    expect(eyeFeatures(points)).toBeUndefined();
  });
});
