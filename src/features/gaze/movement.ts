import { FEATURE_INDEX } from './calibration';
import { median } from './collector';
import { GAZE_TUNING, type MovementTuning } from './tuning';

/** Where the eyes were in the camera image during calibration (normalised image units). */
export type HeadReference = { centreX: number; centreY: number; distance: number };
export type HeadDeviation = {
  /** Relative inter-eye distance change: positive is closer to the camera. */
  distanceRatio: number;
  /** Eye-centre shift in calibrated inter-eye distances. */
  centreShift: number;
};

export function headReference(rows: readonly (readonly number[])[]): HeadReference | undefined {
  const value = (index: number) => median(rows.map((row) => row[index] ?? Number.NaN));
  const reference = {
    centreX: value(FEATURE_INDEX.centreX),
    centreY: value(FEATURE_INDEX.centreY),
    distance: value(FEATURE_INDEX.distance),
  };
  return rows.length && Object.values(reference).every(Number.isFinite) && reference.distance > 0
    ? reference
    : undefined;
}

export function headDeviation(
  reference: HeadReference,
  features: readonly number[],
): HeadDeviation | undefined {
  const x = features[FEATURE_INDEX.centreX];
  const y = features[FEATURE_INDEX.centreY];
  const distance = features[FEATURE_INDEX.distance];
  if (x === undefined || y === undefined || distance === undefined) return undefined;
  const deviation = {
    distanceRatio: distance / reference.distance - 1,
    centreShift: Math.hypot(x - reference.centreX, y - reference.centreY) / reference.distance,
  };
  return Number.isFinite(deviation.distanceRatio) && Number.isFinite(deviation.centreShift)
    ? deviation
    : undefined;
}

/** Warns when the head leaves the calibrated position; clears only once well back in range. */
export class MovementGuard {
  private outside = false;

  constructor(
    private readonly reference: HeadReference,
    private readonly limits: MovementTuning = GAZE_TUNING.movement,
  ) {}

  get moved(): boolean {
    return this.outside;
  }

  update(features: readonly number[]): boolean {
    const deviation = headDeviation(this.reference, features);
    if (!deviation) {
      this.outside = true;
      return true;
    }
    const scale = this.outside ? this.limits.hysteresis : 1;
    this.outside =
      Math.abs(deviation.distanceRatio) > this.limits.distanceRatio * scale ||
      deviation.centreShift > this.limits.centreShift * scale;
    return this.outside;
  }
}
