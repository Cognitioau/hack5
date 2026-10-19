/**
 * Every gaze-lab tuning constant lives here so a live session's exported diagnostics can name
 * the exact values it ran with, and the offline evaluator can sweep them.
 *
 * None of these values has been fitted to human data yet. They are conservative starting points;
 * see docs/STATUS.md for what the first live session should tell us.
 */
export const GAZE_TUNING = {
  collection: {
    /** Samples in the first part of each target are the saccade and reaction period: dropped. */
    settleMs: 350,
    /** Post-settle frames that must agree before a target is captured (~640 ms at 80 ms/frame). */
    stableSamples: 8,
    /**
     * Largest range (max − min, eye widths) of the binocular iris position across the window, on
     * each axis. A range, not a robust spread, so a window that still holds frames from the
     * previous fixation can never pass. 0.03 is under the smallest step between consecutive
     * targets on the synthetic eye (~0.04) and about three standard deviations of 0.01 noise.
     */
    stabilityRange: 0.03,
    /** Frames before this are where the eyes were when the target appeared (saccades start later). */
    onsetMs: 150,
    /**
     * A steady window must lie at least this far (eye widths) from that onset position, so a
     * person still looking at the previous point is not captured there. About half the smallest
     * consecutive-target step on the synthetic eye.
     */
    departureMin: 0.02,
    /** After settling, capture anyway once this long has passed, flagged as unstable. */
    stabilityTimeoutMs: 2500,
    /** A face/eye loss longer than this restarts the stable window (blinks are shorter). */
    lostResetMs: 400,
    /** Frames further than this many robust deviations from the window median are rejected. */
    outlierZ: 3.5,
    /** Floor for the robust deviation so near-constant windows do not reject everything. */
    madFloor: 0.002,
    /** Frames retained per target for the explicit diagnostics export (~6 s at 80 ms/frame). */
    maxRecordedSamples: 75,
    /** Delay before the optional auto-advance moves to the next target after capture. */
    autoAdvanceMs: 300,
  },
  model: {
    /** Ridge penalties tried per session; each calibration target carries a total weight of one. */
    lambdaGrid: [0.01, 0.1, 0.3, 1, 3, 10],
    /** Prefer a simpler candidate whose cross-validated mean error is within this fraction. */
    simplicityMargin: 0.1,
    /** Standardised features are clipped to this many standard deviations in fit and predict. */
    zLimit: 4,
  },
  smoothing: {
    /**
     * One Euro filter (Casiez, Roussel and Vogel, CHI 2012), applied in CSS pixels at ~12.5 Hz.
     * On synthetic white noise of 40–120 px these defaults leave 0.40–0.48 of the raw jitter and
     * reach 90% of a 600 px jump in ~320 ms (a fixed 0.6 Hz low-pass needs ~720 ms).
     */
    minCutoffHz: 0.6,
    /** Cutoff increase (Hz) per pixel/second of filtered speed, so saccades are followed quickly. */
    beta: 0.0005,
    derivativeCutoffHz: 1,
    /** A gap without a prediction longer than this restarts the filter from the next value. */
    resetGapMs: 500,
  },
  movement: {
    /** Relative change in inter-eye distance (towards/away from the camera) that warns. */
    distanceRatio: 0.12,
    /** Eye-centre shift, in calibrated inter-eye distances, that warns. */
    centreShift: 0.5,
    /** Back in range only below this fraction of each limit, so the warning does not flicker. */
    hysteresis: 0.8,
  },
} as const;

export type GazeTuning = typeof GAZE_TUNING;
export type CollectionTuning = {
  -readonly [K in keyof GazeTuning['collection']]: number;
};
export type SmoothingTuning = {
  -readonly [K in keyof GazeTuning['smoothing']]: number;
};
export type MovementTuning = {
  -readonly [K in keyof GazeTuning['movement']]: number;
};
