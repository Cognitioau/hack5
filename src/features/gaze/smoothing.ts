import { GAZE_TUNING, type SmoothingTuning } from './tuning';

const cutoffAlpha = (cutoffHz: number, seconds: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / seconds);
};

/**
 * One Euro filter (Casiez, Roussel and Vogel, CHI 2012): an exponential low-pass whose cutoff
 * rises with the filtered speed. Slow jitter is heavily smoothed; fast saccades keep little lag.
 * Timestamps are milliseconds and may be irregular.
 */
export class OneEuroFilter {
  private previous: { value: number; derivative: number; timestamp: number } | undefined;

  constructor(
    private readonly parameters: Pick<
      SmoothingTuning,
      'minCutoffHz' | 'beta' | 'derivativeCutoffHz'
    > = GAZE_TUNING.smoothing,
  ) {
    const { minCutoffHz, beta, derivativeCutoffHz } = parameters;
    if (
      !(minCutoffHz > 0) ||
      !(derivativeCutoffHz > 0) ||
      !(beta >= 0) ||
      ![minCutoffHz, beta, derivativeCutoffHz].every(Number.isFinite)
    )
      throw new Error('Invalid One Euro filter parameters');
  }

  reset(): void {
    this.previous = undefined;
  }

  filter(value: number, timestamp: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(timestamp))
      throw new Error('One Euro filter needs finite values and timestamps');
    const previous = this.previous;
    if (!previous) {
      this.previous = { value, derivative: 0, timestamp };
      return value;
    }
    const seconds = (timestamp - previous.timestamp) / 1000;
    // Repeated or out-of-order timestamps carry no rate information: hold the last output.
    if (seconds <= 0) return previous.value;
    const rawDerivative = (value - previous.value) / seconds;
    const derivative =
      previous.derivative +
      cutoffAlpha(this.parameters.derivativeCutoffHz, seconds) *
        (rawDerivative - previous.derivative);
    const cutoff = this.parameters.minCutoffHz + this.parameters.beta * Math.abs(derivative);
    const smoothed = previous.value + cutoffAlpha(cutoff, seconds) * (value - previous.value);
    this.previous = { value: smoothed, derivative, timestamp };
    return smoothed;
  }
}

/** Two independent One Euro filters for a viewport point, restarted after a long gap. */
export class PointSmoother {
  private readonly x: OneEuroFilter;
  private readonly y: OneEuroFilter;
  private last: number | undefined;

  constructor(private readonly parameters: SmoothingTuning = GAZE_TUNING.smoothing) {
    this.x = new OneEuroFilter(parameters);
    this.y = new OneEuroFilter(parameters);
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.last = undefined;
  }

  update(point: { x: number; y: number }, timestamp: number): { x: number; y: number } {
    if (this.last !== undefined && timestamp - this.last > this.parameters.resetGapMs) this.reset();
    this.last = timestamp;
    return { x: this.x.filter(point.x, timestamp), y: this.y.filter(point.y, timestamp) };
  }
}
