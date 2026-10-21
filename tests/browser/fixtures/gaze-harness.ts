/**
 * Test-only composition root: the real gaze lab controller with a synthetic landmark source in
 * place of the MediaPipe detector. The camera stream is still Chromium's fake device, so camera
 * ownership and track shutdown are real. Bundled by tests/browser/gaze.spec.ts into a disposable
 * copy of dist; it is never part of the shipped extension.
 */
import type { CameraEnvironment, FacePoint } from '../../../src/adapters/gaze/camera';
import { mountGazeLab } from '../../../src/bootstrap/gaze-lab';

export type HarnessControl = {
  /** Where the synthetic eyes look when no calibration target is visible (viewport fraction). */
  point: { x: number; y: number };
  /** Inter-eye distance multiplier; 1.25 is leaning 25% closer to the camera. */
  distanceScale: number;
  /** Per-frame iris noise in eye widths. */
  noise: number;
  /** Delay before the eyes move to a newly shown target. */
  reactionMs: number;
};
declare global {
  interface Window {
    gazeHarness: HarnessControl;
  }
}
const control: HarnessControl = {
  point: { x: 0.5, y: 0.5 },
  distanceScale: 1,
  noise: 0.006,
  reactionMs: 220,
};
window.gazeHarness = control;

let seed = 7;
const uniform = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gaussian = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

let aim = control.point;
let aimSince = 0;
let looking = control.point;
function gazePoint(time: number) {
  const target = document.getElementById('gaze-target');
  let desired = control.point;
  if (target && !target.hidden) {
    const box = target.getBoundingClientRect();
    desired = {
      x: (box.left + box.width / 2) / innerWidth,
      y: (box.top + box.height / 2) / innerHeight,
    };
  }
  if (desired.x !== aim.x || desired.y !== aim.y) {
    aim = desired;
    // A frame's time is when the frame began, which on a busy machine is before the target
    // was shown; the eyes react from when they first see it, on the lab's own clock.
    aimSince = performance.now();
  }
  if (time - aimSince >= control.reactionMs) looking = aim;
  return looking;
}

function landmarks(time: number): FacePoint[] {
  const gaze = gazePoint(time);
  const scale = control.distanceScale;
  const points: FacePoint[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const width = 0.06 * scale;
  const eye = (
    centreX: number,
    outer: number,
    inner: number,
    top: number,
    bottom: number,
    iris: number,
  ) => {
    const centreY = 0.45;
    points[outer] = { x: centreX - width / 2, y: centreY, z: 0 };
    points[inner] = { x: centreX + width / 2, y: centreY, z: 0 };
    points[top] = { x: centreX, y: centreY - 0.012 * scale, z: 0 };
    points[bottom] = { x: centreX, y: centreY + 0.012 * scale, z: 0 };
    const h = 0.2 * (gaze.x - 0.5) + control.noise * gaussian();
    const v = 0.12 * (gaze.y - 0.5) + control.noise * gaussian();
    points[iris] = { x: centreX + h * width, y: centreY + v * width, z: 0 };
  };
  eye(0.5 - 0.07 * scale, 33, 133, 159, 145, 468);
  eye(0.5 + 0.07 * scale, 362, 263, 386, 374, 473);
  points[1] = { x: 0.5, y: 0.45 + 0.07 * scale, z: 0 };
  return points;
}

const environment: CameraEnvironment = {
  detector: async () => ({
    detectForVideo: (_video, time) => ({ faceLandmarks: [landmarks(time)] }),
    close: () => undefined,
  }),
  stream: () => navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};
mountGazeLab(environment);
