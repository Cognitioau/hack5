import { GazeCamera, type CameraEnvironment } from '../adapters/gaze/camera';
import {
  CALIBRATION_TARGETS,
  VALIDATION_TARGETS,
  VARIANT_LABELS,
  eyeFeatures,
  holdoutDiagnostics,
  predictGaze,
  sameGeometry,
  type ViewportGeometry,
} from '../features/gaze/calibration';
import { TargetCollector, type CollectionState } from '../features/gaze/collector';
import {
  JitterTracker,
  buildDiagnostics,
  type TargetRecord,
  type ValidationRecord,
} from '../features/gaze/diagnostics';
import { MovementGuard, headDeviation, headReference } from '../features/gaze/movement';
import { pixelError, selectGazeModel, type Selection } from '../features/gaze/selection';
import { PointSmoother } from '../features/gaze/smoothing';
import { GAZE_TUNING } from '../features/gaze/tuning';

const LIVE_MESSAGE =
  'Live gaze estimate is shown by the purple dot. It remains an experiment on this page; capture is not connected.';
const MOVED_MESSAGE =
  'You’ve moved — recalibrate for accuracy. The dot is hidden until you return.';
const rounded = (value: number) => Math.round(value);

/**
 * The gaze lab page. The camera environment is injectable so a browser test can compose this
 * same controller with a synthetic landmark source; the shipped page uses the packaged model.
 */
export function mountGazeLab(environment?: CameraEnvironment): void {
  const element = <T extends HTMLElement>(id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing gaze control: ${id}`);
    return found as T;
  };
  const start = element<HTMLButtonElement>('gaze-start');
  const calibrate = element<HTMLButtonElement>('gaze-calibrate');
  const download = element<HTMLButtonElement>('gaze-export');
  const auto = element<HTMLInputElement>('gaze-auto');
  const stop = element<HTMLButtonElement>('gaze-stop');
  const target = element<HTMLButtonElement>('gaze-target');
  const targetLabel = element('gaze-target-label');
  const panel = element('gaze-panel');
  const step = element('gaze-step');
  const dot = element('gaze-dot');
  const status = element('gaze-status');
  const diagnostics = element('gaze-diagnostics');
  const exportStatus = element('gaze-export-status');

  type Phase = 'stopped' | 'starting' | 'preview' | 'calibrating' | 'validating' | 'ready';
  let phase: Phase = 'stopped';
  let generation = 0;
  let position = 0;
  let shownAt = 0;
  let collector: TargetCollector | undefined;
  let calibration: TargetRecord[] = [];
  let validation: ValidationRecord[] = [];
  let selection: Selection | undefined;
  let holdout: ReturnType<typeof holdoutDiagnostics> | undefined;
  let guard: MovementGuard | undefined;
  let reference: ReturnType<typeof headReference>;
  let geometry: ViewportGeometry | undefined;
  let jitter: JitterTracker | undefined;
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  let faceVisible = false;
  let movedShown = false;
  const smoother = new PointSmoother();

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
  const targets = () => (phase === 'calibrating' ? CALIBRATION_TARGETS : VALIDATION_TARGETS);
  const currentTarget = () => targets()[position];

  function setPhase(next: Phase) {
    phase = next;
    document.body.dataset.gazePhase = next;
    const collecting = next === 'calibrating' || next === 'validating';
    panel.hidden = collecting;
    target.hidden = !collecting;
    step.hidden = !collecting;
    start.disabled = next !== 'stopped';
    stop.disabled = next === 'stopped';
    auto.disabled = collecting;
    download.hidden = next !== 'ready';
    if (next !== 'ready') {
      dot.hidden = true;
      exportStatus.textContent = '';
    }
  }
  function resetCalibration() {
    clearTimeout(advanceTimer);
    advanceTimer = undefined;
    collector = undefined;
    calibration = [];
    validation = [];
    selection = undefined;
    holdout = undefined;
    guard = undefined;
    reference = undefined;
    geometry = undefined;
    jitter = undefined;
    movedShown = false;
    smoother.reset();
  }
  function clearSession(text = 'Camera is off. Session and calibration cleared.') {
    generation++;
    camera.stop();
    resetCalibration();
    faceVisible = false;
    calibrate.disabled = true;
    setPhase('stopped');
    message(text);
    diagnostics.textContent = 'Calibration is held only for the current visible-page session.';
  }
  function invalidate(text = 'Window geometry changed. Keep it steady and calibrate again.') {
    resetCalibration();
    calibrate.disabled = !faceVisible;
    setPhase('preview');
    message(text);
    diagnostics.textContent = 'The previous calibration has been discarded.';
  }

  function renderTarget(state: CollectionState) {
    target.style.setProperty('--gaze-progress', String(state.progress));
    target.dataset.state = state.phase;
    const captured = state.phase === 'captured';
    const wasDisabled = target.disabled;
    target.disabled = !captured;
    targetLabel.textContent = captured ? (auto.checked ? 'Got it' : 'Click') : '';
    const label = `${phase === 'calibrating' ? 'Calibration point' : 'Check'} ${position + 1}`;
    target.setAttribute(
      'aria-label',
      captured
        ? `${label} captured. ${auto.checked ? 'Moving on.' : 'Click or press Space to continue.'}`
        : `${label}: keep looking at the centre dot.`,
    );
    if (captured && wasDisabled) {
      if (auto.checked) {
        const attempt = generation;
        const index = position;
        const owner = phase;
        advanceTimer = setTimeout(() => {
          if (attempt === generation && index === position && owner === phase) advance();
        }, GAZE_TUNING.collection.autoAdvanceMs);
      } else target.focus({ preventScroll: true });
    }
  }
  function showTarget() {
    const point = currentTarget();
    if (!point) return;
    target.style.left = `${point.x * innerWidth}px`;
    target.style.top = `${point.y * innerHeight}px`;
    collector = new TargetCollector();
    shownAt = performance.now();
    renderTarget({ phase: 'settling', progress: 0 });
    step.textContent = `${phase === 'calibrating' ? 'Calibration' : 'Separate check'} ${position + 1} / ${targets().length} — look at the centre dot until it shrinks away${auto.checked ? '; the next point follows automatically.' : ', then click it or press Space.'}`;
  }

  function finishCalibration() {
    if (!geometry) return;
    try {
      selection = selectGazeModel(
        calibration.map((record) => ({
          target: record.target,
          rows: record.captured.rows,
          features: record.captured.features,
        })),
        geometry,
      );
    } catch {
      invalidate('Calibration could not be fitted. Reposition and try again.');
      return;
    }
    reference = headReference(calibration.flatMap((record) => record.captured.rows));
    guard = reference ? new MovementGuard(reference) : undefined;
    position = 0;
    setPhase('validating');
    showTarget();
  }
  function finishValidation() {
    if (!selection) return;
    holdout = holdoutDiagnostics(validation.map((record) => record.errorPixels));
    const { chosen } = selection;
    const unstable = [...calibration, ...validation].filter(
      (record) => !record.captured.stable,
    ).length;
    diagnostics.textContent = `Model chosen by leave-one-out cross-validation: ${VARIANT_LABELS[chosen.variant]}, λ ${chosen.lambda} (median ${rounded(chosen.medianPixels)} px, largest ${rounded(chosen.maximumPixels)} px across ${calibration.length} calibration points). ${holdout.points} separate checks: median deviation ${rounded(holdout.medianPixels)} px; largest deviation ${rounded(holdout.maximumPixels)} px. These are measured against the points you looked at in this session.${unstable ? ` ${unstable} point${unstable === 1 ? ' was' : 's were'} captured by timeout: the eyes were not steady, or had not moved from where they were when the point appeared.` : ''}`;
    jitter = new JitterTracker();
    smoother.reset();
    setPhase('ready');
    message(LIVE_MESSAGE);
  }
  function advance() {
    const point = currentTarget();
    const captured = collector?.result;
    if (!point || !captured || !collector || !geometry || !sameGeometry(geometry, viewport()))
      return;
    clearTimeout(advanceTimer);
    advanceTimer = undefined;
    const record: TargetRecord = {
      index: position,
      target: { x: point.x, y: point.y },
      samples: [...collector.samples],
      captured,
    };
    collector = undefined;
    if (phase === 'calibrating') {
      calibration.push(record);
      position++;
      if (position === CALIBRATION_TARGETS.length) finishCalibration();
      else showTarget();
    } else if (phase === 'validating' && selection) {
      const prediction = predictGaze(selection.model, captured.features);
      if (!prediction) {
        invalidate('The calibration could not predict this check. Reposition and try again.');
        return;
      }
      validation.push({
        ...record,
        prediction,
        errorPixels: pixelError(prediction, point, geometry),
        movement: reference ? (headDeviation(reference, captured.features) ?? null) : null,
      });
      position++;
      if (position === VALIDATION_TARGETS.length) finishValidation();
      else showTarget();
    }
  }

  function live(features: number[] | undefined, timestamp: number) {
    if (!selection || !jitter) return;
    if (!features) {
      dot.hidden = true;
      jitter.interrupt('lost', timestamp);
      return;
    }
    if (guard?.update(features)) {
      if (!movedShown) message(MOVED_MESSAGE);
      movedShown = true;
      dot.hidden = true;
      smoother.reset();
      jitter.interrupt('moved', timestamp);
      return;
    }
    if (movedShown) message(LIVE_MESSAGE);
    movedShown = false;
    const prediction = predictGaze(selection.model, features);
    if (!prediction) {
      dot.hidden = true;
      jitter.interrupt('lost', timestamp);
      return;
    }
    const raw = { x: prediction.x * innerWidth, y: prediction.y * innerHeight };
    const smoothed = smoother.update(raw, timestamp);
    const inside =
      smoothed.x >= 0 && smoothed.x <= innerWidth && smoothed.y >= 0 && smoothed.y <= innerHeight;
    jitter.add(raw, smoothed, timestamp, inside);
    if (!inside) {
      dot.hidden = true;
      return;
    }
    dot.style.left = `${smoothed.x}px`;
    dot.style.top = `${smoothed.y}px`;
    dot.hidden = false;
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
      faceVisible = !!features;
      calibrate.disabled = !features;
      if (phase === 'preview')
        message(
          features
            ? 'Face and eye landmarks found. Begin calibration when your position is comfortable.'
            : 'Camera is running. Position one face in view with both eyes open.',
        );
      if ((phase === 'calibrating' || phase === 'validating') && collector)
        renderTarget(collector.add(timestamp - shownAt, features));
      if (phase === 'ready') live(features, timestamp);
    },
    (error) =>
      clearSession(
        `Camera processing stopped: ${error instanceof Error ? error.message : 'local runtime failure'}`,
      ),
    environment,
  );

  function exportDiagnostics() {
    if (phase !== 'ready' || !selection || !holdout || !geometry) return;
    const report = buildDiagnostics({
      createdAt: new Date().toISOString(),
      extensionVersion: globalThis.chrome?.runtime?.getManifest?.().version ?? null,
      viewport: geometry,
      calibration,
      validation,
      selection,
      holdout,
      live: jitter?.summary() ?? null,
    });
    // A Blob download is local: no network request, so the page's connect-src 'self' still holds.
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `zombie-hand-gaze-diagnostics-${report.createdAt.replace(/[:.]/g, '-')}.json`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportStatus.textContent = `Started downloading ${anchor.download}. The file stays on this device unless you share it.`;
  }

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
    if (!faceVisible) return;
    resetCalibration();
    geometry = viewport();
    position = 0;
    setPhase('calibrating');
    message('Calibrating. Keep your head and the window still.');
    diagnostics.textContent = 'Calibration in progress; the previous calibration was discarded.';
    showTarget();
  });
  target.addEventListener('click', advance);
  download.addEventListener('click', exportDiagnostics);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && phase !== 'stopped')
      clearSession('Camera stopped because the gaze lab became hidden.');
  });
  window.addEventListener('pagehide', () => clearSession());
  window.addEventListener('resize', () => {
    if (geometry) invalidate();
  });
  setPhase('stopped');
}
