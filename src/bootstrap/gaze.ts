import { GazeCamera } from '../adapters/gaze/camera';
import {
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS,
  eyeFeatures,
  fitGaze,
  predictGaze,
  sameGeometry,
  holdoutDiagnostics,
  type GazeModel,
  type Sample,
  type ViewportGeometry,
} from '../features/gaze/calibration';

const element = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing gaze control: ${id}`);
  return found as T;
};
const start = element<HTMLButtonElement>('gaze-start');
const calibrate = element<HTMLButtonElement>('gaze-calibrate');
const stop = element<HTMLButtonElement>('gaze-stop');
const target = element<HTMLButtonElement>('gaze-target');
const panel = element('gaze-panel');
const step = element('gaze-step');
const dot = element('gaze-dot');
const status = element('gaze-status');
const diagnostics = element('gaze-diagnostics');
type Phase = 'stopped' | 'starting' | 'preview' | 'calibrating' | 'validating' | 'ready';
let phase: Phase = 'stopped';
let generation = 0;
let position = 0;
let samples: Sample[] = [];
let errors: number[] = [];
let history: { features: number[]; timestamp: number }[] = [];
let model: GazeModel | undefined;
let geometry: ViewportGeometry | undefined;
const viewport = (): ViewportGeometry => ({
  width: innerWidth,
  height: innerHeight,
  screenX,
  screenY,
  outerWidth,
  outerHeight,
  pixelRatio: devicePixelRatio,
});
const message = (text: string) => {
  status.textContent = text;
};
function setPhase(next: Phase) {
  phase = next;
  document.body.dataset.gazePhase = next;
  const collecting = next === 'calibrating' || next === 'validating';
  panel.hidden = collecting;
  target.hidden = !collecting;
  step.hidden = !collecting;
  start.disabled = next !== 'stopped';
  stop.disabled = next === 'stopped';
  if (next !== 'ready') dot.hidden = true;
}
function clearSession(text = 'Camera is off. Session and calibration cleared.') {
  generation++;
  camera.stop();
  model = undefined;
  geometry = undefined;
  samples = [];
  history = [];
  errors = [];
  calibrate.disabled = true;
  setPhase('stopped');
  message(text);
  diagnostics.textContent = 'Calibration is held only for the current visible-page session.';
}
function invalidate() {
  model = undefined;
  geometry = undefined;
  samples = [];
  errors = [];
  history = [];
  calibrate.disabled = true;
  setPhase('preview');
  message('Window geometry changed. Keep it steady and calibrate again.');
  diagnostics.textContent = 'The previous calibration has been discarded.';
}
function currentTarget() {
  return (phase === 'calibrating' ? CALIBRATION_TARGETS : VALIDATION_TARGETS)[position];
}
function showTarget() {
  const point = currentTarget();
  if (!point) return;
  target.style.left = `${point.x * innerWidth}px`;
  target.style.top = `${point.y * innerHeight}px`;
  target.disabled = true;
  target.textContent = 'Look here';
  history = [];
  step.textContent = `${phase === 'calibrating' ? 'Calibration' : 'Separate check'} ${position + 1} / ${phase === 'calibrating' ? CALIBRATION_TARGETS.length : VALIDATION_TARGETS.length} — look at the target, then click when ready.`;
}
const camera = new GazeCamera(
  element<HTMLVideoElement>('gaze-video'),
  (points, timestamp) => {
    if (phase === 'stopped' || phase === 'starting') return;
    if (geometry && !sameGeometry(geometry, viewport())) {
      invalidate();
      return;
    }
    const features = eyeFeatures(points);
    if (!features) {
      history = [];
      target.disabled = true;
      calibrate.disabled = true;
      dot.hidden = true;
      if (phase === 'preview')
        message('Camera is running. Position one face in view with both eyes open.');
      return;
    }
    history.push({ features, timestamp });
    history = history.filter((sample) => timestamp - sample.timestamp <= 1200).slice(-12);
    calibrate.disabled = false;
    if (phase === 'preview')
      message('Face and eye landmarks found. Begin calibration when your position is comfortable.');
    if (phase === 'calibrating' || phase === 'validating') {
      target.disabled = history.length < 8;
      target.textContent = target.disabled ? 'Look here' : 'Click';
    }
    if (phase === 'ready' && model) {
      const prediction = predictGaze(model, features);
      if (
        !prediction ||
        prediction.x < 0 ||
        prediction.x > 1 ||
        prediction.y < 0 ||
        prediction.y > 1
      ) {
        dot.hidden = true;
        return;
      }
      dot.style.left = `${prediction.x * innerWidth}px`;
      dot.style.top = `${prediction.y * innerHeight}px`;
      dot.hidden = false;
    }
  },
  (error) =>
    clearSession(
      `Camera processing stopped: ${error instanceof Error ? error.message : 'local runtime failure'}`,
    ),
);

start.addEventListener('click', () => {
  const attempt = ++generation;
  setPhase('starting');
  calibrate.disabled = true;
  message('Loading the packaged landmark model, then requesting camera access…');
  void camera
    .start()
    .then(() => {
      if (attempt !== generation) return;
      setPhase('preview');
      message('Camera is running. Position one face in view with both eyes open.');
    })
    .catch((error: unknown) => {
      if (attempt === generation)
        clearSession(
          `Could not start: ${error instanceof Error ? error.message : 'camera or local model unavailable'}`,
        );
    });
});
stop.addEventListener('click', () => clearSession());
calibrate.addEventListener('click', () => {
  if (!history.length) return;
  model = undefined;
  samples = [];
  errors = [];
  geometry = viewport();
  position = 0;
  setPhase('calibrating');
  showTarget();
});
target.addEventListener('click', () => {
  const point = currentTarget();
  if (!point || history.length < 8 || !geometry || !sameGeometry(geometry, viewport())) return;
  const features = history[0]?.features.map(
    (_, index) =>
      history.reduce((sum, sample) => sum + (sample.features[index] ?? 0), 0) / history.length,
  );
  if (!features) return;
  if (phase === 'calibrating') {
    for (const sample of history) samples.push({ features: sample.features, target: point });
    position++;
    if (position === CALIBRATION_TARGETS.length) {
      try {
        model = fitGaze(samples);
      } catch {
        invalidate();
        message('Calibration could not be fitted. Reposition and try again.');
        return;
      }
      position = 0;
      setPhase('validating');
    }
    showTarget();
  } else if (phase === 'validating' && model) {
    const prediction = predictGaze(model, features);
    if (!prediction) {
      invalidate();
      return;
    }
    errors.push(
      Math.hypot((prediction.x - point.x) * innerWidth, (prediction.y - point.y) * innerHeight),
    );
    position++;
    if (position === VALIDATION_TARGETS.length) {
      const measured = holdoutDiagnostics(errors);
      diagnostics.textContent = `${measured.points} separate checks: median deviation ${Math.round(measured.medianPixels)} px; largest deviation ${Math.round(measured.maximumPixels)} px. These are measured against the points you looked at and clicked in this session.`;
      samples = [];
      errors = [];
      history = [];
      setPhase('ready');
      message(
        'Live gaze estimate is shown by the purple dot. It remains an experiment on this page; capture is not connected.',
      );
    } else showTarget();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase !== 'stopped')
    clearSession('Camera stopped because the gaze lab became hidden.');
});
window.addEventListener('pagehide', () => clearSession());
window.addEventListener('resize', () => {
  if (geometry) invalidate();
});
setPhase('stopped');
