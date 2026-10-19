import type { AppResponse, ContentMessage, Features, PublicCapture } from '../core/contracts/index';
import { GestureTracker, type GesturePoint } from '../core/domain/gestures';
import {
  extractCandidate,
  isEditable,
  targetRectangle,
  type ExtractedCandidate,
} from '../adapters/browser/extraction';
import { currentVideoSeconds, extractYouTubeCandidate } from '../features/youtube/transcript';
import { HandView } from '../ui/hand';

type Phase = 'idle' | 'arming' | 'armed' | 'saving' | 'saved' | 'error';
type SessionWindow = Window & { __zombieHandDispose?: () => void };
const sessionWindow = window as SessionWindow;

/** Only an explicitly injected content entry installs listeners on a page. */
function activate(): () => void {
  let disposed = false;
  let generation = 0;
  let pageUrl = location.href;
  let phase: Phase = 'idle';
  let features: Features = {
    images: false,
    youtube: false,
    haunting: false,
    semantic: false,
    gaze: false,
  };
  let point: GesturePoint = { x: innerWidth / 2, y: innerHeight / 2, at: performance.now() };
  let anchor = point;
  let locked: ExtractedCandidate | null = null;
  let token: string | null = null;
  let operationId: string | null = null;
  let tracker: GestureTracker | null = null;
  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  let armExpiry: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenForSnapshot = false;
  let ghostEpoch = 0;
  let lastGhostAt = Number.NEGATIVE_INFINITY;
  let lastUndo: { captureId: string; until: number } | null = null;
  let rearmAfter = 0;
  const ownedIds = new Set<string>();
  const cancellationRequested = new Set<string>();
  const acknowledgedSaves = new Set<string>();
  const listeners = new AbortController();

  const request = async (message: ContentMessage): Promise<AppResponse> => {
    try {
      return (await chrome.runtime.sendMessage(message)) as AppResponse;
    } catch {
      return {
        ok: false,
        error: 'The extension connection was interrupted. Reopen Zombie Hand to reconnect.',
      };
    }
  };

  const clearArmTimers = (): void => {
    clearTimeout(dwellTimer);
    clearTimeout(armExpiry);
    dwellTimer = undefined;
    armExpiry = undefined;
  };

  const idle = (
    detail = 'Pause over a phrase to wake the hand. Circle to grab. Shake to let go.',
  ): void => {
    if (disposed) return;
    phase = 'idle';
    locked = null;
    token = null;
    operationId = null;
    tracker = lastUndo ? new GestureTracker(point) : null;
    view.setUndoAvailable(lastUndo !== null);
    view.setTarget(null);
    view.setState('idle', 'A little hungry.', detail);
  };

  const showError = (detail: string): void => {
    phase = 'error';
    view.setTarget(null);
    view.setState('error', 'Still here. Still yours.', detail);
  };

  const renderCapture = (capture: PublicCapture): void => {
    if (disposed || !ownedIds.has(capture.id)) return;
    if (cancellationRequested.has(capture.id) && capture.lifecycle !== 'archived') return;
    if (phase === 'arming' || phase === 'armed') return;
    // Older completion messages must not replace the next capture's UI.
    if (operationId && capture.id !== operationId) return;
    if (!operationId && lastUndo && capture.id !== lastUndo.captureId) return;
    if (capture.lifecycle === 'archived') {
      clearTimeout(pollTimer);
      lastUndo = null;
      view.setUndoAvailable(false);
      idle(
        capture.persistence === 'saved-vault'
          ? 'Spat back. The note is archived in your vault; its content is retained.'
          : 'Archived locally. Vault confirmation is still pending; the content is retained.',
      );
      view.setState(
        'archived',
        'Back from the grave.',
        capture.persistence === 'saved-vault'
          ? 'Archived in the vault. Nothing was deleted.'
          : 'Archived locally. Vault confirmation is still pending.',
      );
      return;
    }
    if (capture.persistence === 'saved-vault') {
      if (acknowledgedSaves.has(capture.id)) return;
      acknowledgedSaves.add(capture.id);
      rearmAfter = performance.now() + 600;
      clearTimeout(pollTimer);
      phase = 'saved';
      locked = null;
      token = null;
      operationId = null;
      lastUndo = { captureId: capture.id, until: performance.now() + 6_000 };
      tracker = new GestureTracker(point);
      view.setUndoAvailable(true);
      view.setTarget(null);
      const preservation =
        capture.preservation === 'file'
          ? 'A local attachment is saved.'
          : capture.preservation === 'screenshot'
            ? 'A cropped screenshot is saved.'
            : capture.preservation === 'link'
              ? 'The source link is saved; media bytes were not retained.'
              : 'Your words are saved.';
      const transcript = capture.candidate.video?.transcript;
      const transcriptDetail = transcript
        ? transcript.cues.length > 0
          ? ' Available transcript cues are included; coverage is partial.'
          : ' No transcript was read. Open YouTube’s Show transcript panel before the next capture.'
        : '';
      view.setState(
        'saved',
        'Buried, safely.',
        `${preservation}${transcriptDetail} Shake now to spit it back.`,
      );
      return;
    }
    if (capture.persistence === 'queued-local' || capture.persistence === 'uncertain') {
      phase = 'saving';
      view.setState(
        'saving',
        capture.persistence === 'uncertain' ? 'Waiting for a receipt.' : 'Held in the hand.',
        capture.persistence === 'uncertain'
          ? 'The vault response was uncertain. Kept locally while the write is reconciled. Shake to cancel.'
          : 'Queued locally. The hand will say saved only after the vault confirms it.',
      );
      return;
    }
    clearTimeout(pollTimer);
    lastUndo = { captureId: capture.id, until: performance.now() + 6_000 };
    token = null;
    operationId = null;
    locked = null;
    view.setUndoAvailable(true);
    showError(
      capture.persistence === 'conflict'
        ? 'Kept locally. The vault contains a conflicting change; review it in the graveyard.'
        : capture.lastError ||
            'Kept locally, but the vault save failed. Check the connection in the graveyard.',
    );
  };

  const poll = (captureId: string, count = 0): void => {
    clearTimeout(pollTimer);
    if (disposed || count >= 30 || operationId !== captureId) return;
    pollTimer = setTimeout(() => {
      void request({ v: 1, type: 'GET_CAPTURE', captureId }).then((response) => {
        if (disposed || operationId !== captureId) return;
        if (response.ok && response.capture) renderCapture(response.capture);
        if (operationId === captureId) poll(captureId, count + 1);
      });
    }, 2_000);
  };

  const release = async (): Promise<void> => {
    const previousToken = token;
    const previousOperation = operationId;
    generation += 1;
    clearArmTimers();
    clearTimeout(pollTimer);
    token = null;
    locked = null;
    tracker = null;
    if (!previousToken) {
      idle('Let go. Nothing new was captured.');
      return;
    }
    if (previousOperation) {
      cancellationRequested.add(previousOperation);
      phase = 'saving';
      view.setState(
        'saving',
        'Letting go…',
        'Recording the cancellation. Any completed save will remain archived.',
      );
    }
    const response = await request({
      v: 1,
      type: 'CANCEL',
      token: previousToken,
      ...(previousOperation ? { operationId: previousOperation } : {}),
    });
    if (disposed) return;
    if (!response.ok) {
      if (previousOperation) {
        cancellationRequested.delete(previousOperation);
        lastUndo = { captureId: previousOperation, until: 0 };
        operationId = null;
        view.setUndoAvailable(true);
      }
      showError(response.error);
      return;
    }
    if (response.capture) renderCapture(response.capture);
    else {
      operationId = null;
      idle(
        previousOperation
          ? 'Cancellation recorded. Any completed vault write remains archived.'
          : 'Let go. Nothing new was captured.',
      );
    }
  };

  const archive = async (): Promise<void> => {
    if (!lastUndo || disposed || ['arming', 'armed', 'saving'].includes(phase)) return;
    const captureId = lastUndo.captureId;
    cancellationRequested.add(captureId);
    lastUndo = null;
    tracker = null;
    view.setUndoAvailable(false);
    phase = 'saving';
    view.setState(
      'saving',
      'Spitting it back…',
      'Archiving the latest capture. Its files will be retained.',
    );
    const response = await request({ v: 1, type: 'ARCHIVE', captureId });
    if (disposed) return;
    if (!response.ok) {
      cancellationRequested.delete(captureId);
      lastUndo = { captureId, until: performance.now() + 6_000 };
      view.setUndoAvailable(true);
      showError(response.error);
      return;
    }
    if (response.capture) renderCapture(response.capture);
    else idle('Archive requested. Check the graveyard for vault confirmation.');
  };

  const confirm = async (): Promise<void> => {
    if (phase !== 'armed' || !token || !locked || disposed) return;
    if (!locked.target.isConnected || location.href !== pageUrl) {
      await release();
      return;
    }
    clearArmTimers();
    const capturedToken = token;
    const epoch = generation;
    const videoSeconds =
      !__CORE_ONLY__ && locked.candidate.video
        ? currentVideoSeconds(document, locked.candidate.video.id)
        : null;
    if (locked.candidate.video && videoSeconds === null) {
      await release();
      return;
    }
    operationId = crypto.randomUUID();
    const captureId = operationId;
    ownedIds.add(captureId);
    phase = 'saving';
    tracker = new GestureTracker(point);
    view.setUndoAvailable(false);
    view.setState(
      'saving',
      'Taking hold…',
      'Preparing a durable local capture. Shake or press Escape to cancel.',
    );
    const response = await request({
      v: 1,
      type: 'CAPTURE',
      token: capturedToken,
      operationId: captureId,
      ...(videoSeconds === null ? {} : { videoSeconds }),
    });
    if (disposed || epoch !== generation) return;
    if (!response.ok) {
      operationId = null;
      token = null;
      showError(response.error);
      return;
    }
    if (response.capture) renderCapture(response.capture);
    if (operationId === captureId) poll(captureId);
  };

  const candidateAt = (preferSelection = false): ExtractedCandidate | null => {
    const extracted = extractCandidate(document, point, {
      preferSelection,
      ...(!__CORE_ONLY__ && features.youtube ? { special: extractYouTubeCandidate } : {}),
    });
    if (extracted?.candidate.kind === 'image' && !features.images) return null;
    return extracted;
  };

  const askGhost = (candidate: ExtractedCandidate): void => {
    if (!features.haunting || performance.now() - lastGhostAt < 30_000) return;
    const query = candidate.candidate.text.slice(0, 2_000);
    if (query.length < 20) return;
    lastGhostAt = performance.now();
    const epoch = ++ghostEpoch;
    void request({ v: 1, type: 'SEARCH', query }).then((response) => {
      if (!disposed && epoch === ghostEpoch && features.haunting && response.ok)
        view.setGhost(response.results?.[0] ?? null);
    });
  };

  const arm = async (candidate: ExtractedCandidate, captureImmediately = false): Promise<void> => {
    if (disposed || phase === 'saving') return;
    clearArmTimers();
    const epoch = ++generation;
    phase = 'arming';
    if (lastUndo) lastUndo.until = 0;
    locked = candidate;
    anchor = { ...point };
    const frozenPage = location.href;
    view.setUndoAvailable(false);
    view.setTarget(candidate.rectangle, candidate.candidate.text || candidate.candidate.title);
    view.setState('arming', 'Something caught its eye.', 'Locking this target…');
    const response = await request({
      v: 1,
      type: 'ARM',
      candidate: candidate.candidate,
      pageUrl: frozenPage,
    });
    if (disposed || epoch !== generation || location.href !== frozenPage) {
      if (response.ok && response.token)
        void request({ v: 1, type: 'CANCEL', token: response.token });
      return;
    }
    if (!response.ok || !response.token) {
      locked = null;
      showError(response.ok ? 'The target could not be armed.' : response.error);
      return;
    }
    token = response.token;
    operationId = null;
    pageUrl = frozenPage;
    phase = 'armed';
    tracker = new GestureTracker(anchor);
    view.setState(
      'armed',
      'Make a little circle.',
      candidate.candidate.kind === 'youtube' &&
        candidate.candidate.video?.transcript.cues.length === 0
        ? 'Target locked. Open Show transcript before arming to include captions. Circle to capture this moment, or shake to let go.'
        : 'Target locked. Circle clockwise or anticlockwise to grab it; shake to let go.',
    );
    armExpiry = setTimeout(() => {
      void release();
    }, 25_000);
    askGhost(candidate);
    if (captureImmediately) await confirm();
  };

  const captureAccessible = async (): Promise<void> => {
    if (phase === 'armed') {
      await confirm();
      return;
    }
    if (phase === 'saving') return;
    const candidate = candidateAt(true);
    if (!candidate) {
      showError(
        'Select page text or point at a phrase, image or video first. Form fields are excluded.',
      );
      return;
    }
    await arm(candidate, true);
  };

  const view = new HandView(document, {
    capture: () => {
      void captureAccessible();
    },
    cancel: () => {
      void release();
    },
    archive: () => {
      void archive();
    },
    close: () => dispose(),
  });

  const pointerMove = (event: PointerEvent): void => {
    if (
      !event.isTrusted ||
      disposed ||
      hiddenForSnapshot ||
      view.contains(event) ||
      event.pointerType === 'touch'
    )
      return;
    point = { x: event.clientX, y: event.clientY, at: performance.now() };
    view.move(point.x, point.y);
    if (phase === 'armed' || phase === 'saving') {
      const decision = tracker?.add(point, phase === 'armed');
      if (decision === 'confirm') void confirm();
      else if (decision === 'cancel') void release();
      return;
    }
    if (lastUndo && point.at <= lastUndo.until && tracker?.add(point, false) === 'cancel') {
      void archive();
      return;
    }
    // The final pointer samples of a successful circle belong to that same
    // gesture. A fast vault response must not immediately arm another target.
    if (point.at < rearmAfter) return;
    if (Math.hypot(point.x - anchor.x, point.y - anchor.y) <= 9 && dwellTimer) return;
    clearTimeout(dwellTimer);
    dwellTimer = undefined;
    if (phase === 'arming') {
      // A resolved ARM locks the target; only the preceding dwell can drift.
      if (locked) return;
      phase = 'idle';
    }
    anchor = { ...point };
    const candidate = candidateAt();
    if (!candidate) return;
    phase = 'arming';
    locked = null;
    view.setUndoAvailable(false);
    view.setTarget(candidate.rectangle, candidate.candidate.text || candidate.candidate.title);
    view.setState('arming', 'Wait for it…', 'Hold still briefly to arm this target.');
    dwellTimer = setTimeout(() => {
      dwellTimer = undefined;
      void arm(candidate);
    }, 800);
  };

  const invalidateTarget = (): void => {
    if (phase === 'arming' || phase === 'armed') void release();
  };

  const refreshFeatures = async (): Promise<void> => {
    const response = await request({ v: 1, type: 'CONTENT_STATUS' });
    if (disposed) return;
    if (!response.ok) {
      showError(response.error);
      return;
    }
    if (response.features) features = response.features;
    if (__CORE_ONLY__) features = { ...features, images: false, youtube: false, gaze: false };
    if (!features.haunting) {
      ghostEpoch += 1;
      view.setGhost(null);
    }
    if (
      locked &&
      ((locked.candidate.kind === 'image' && !features.images) ||
        (locked.candidate.kind === 'youtube' && !features.youtube))
    )
      void release();
  };

  const snapshotEvidence = ():
    | { ok: false; valid: false }
    | {
        ok: true;
        valid: true;
        pageUrl: string;
        rect: ReturnType<typeof targetRectangle>;
        currentImageUrl: string;
      } => {
    if (
      locked?.candidate.kind !== 'image' ||
      !locked.target.isConnected ||
      location.href !== pageUrl
    )
      return { ok: false, valid: false };
    const actual = targetRectangle(locked.target, document);
    const expected = locked.rectangle;
    const aligned = (Object.keys(expected) as (keyof typeof expected)[]).every(
      (key) => Math.abs(actual[key] - expected[key]) <= 1,
    );
    const image = locked.target instanceof HTMLImageElement ? locked.target : null;
    const currentImageUrl = image?.currentSrc || image?.src;
    if (!aligned || !currentImageUrl || currentImageUrl !== locked.candidate.image?.url)
      return { ok: false, valid: false };
    return { ok: true, valid: true, pageUrl: location.href, rect: actual, currentImageUrl };
  };

  const runtimeListener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null)
      return false;
    const data = message as { v?: number; type?: string; capture?: PublicCapture };
    if (data.v !== 1) return false;
    switch (data.type) {
      case 'CAPTURE_UPDATE':
        if (data.capture) renderCapture(data.capture);
        sendResponse({ ok: true });
        return false;
      case 'HIDE_OVERLAY':
        if (!snapshotEvidence().valid) {
          sendResponse({ ok: false, valid: false });
          return false;
        }
        hiddenForSnapshot = true;
        view.setHidden(true);
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          if (!disposed) {
            hiddenForSnapshot = false;
            view.setHidden(false);
          }
        }, 5_000);
        requestAnimationFrame(() => requestAnimationFrame(() => sendResponse(snapshotEvidence())));
        return true;
      case 'RESTORE_OVERLAY':
        clearTimeout(restoreTimer);
        hiddenForSnapshot = false;
        view.setHidden(false);
        sendResponse({ ok: true });
        return false;
      case 'SETTINGS_CHANGED':
        generation += 1;
        clearArmTimers();
        clearTimeout(pollTimer);
        lastUndo = null;
        ownedIds.clear();
        cancellationRequested.clear();
        acknowledgedSaves.clear();
        // Changing settings invalidates background capabilities, including the
        // token for an already armed target. Durable work stays in the journal.
        idle(
          'Settings changed. Pause to arm a new target; pending captures remain in the graveyard.',
        );
        void refreshFeatures();
        sendResponse({ ok: true });
        return false;
      case 'DEACTIVATE':
        dispose();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  };

  const navigationTimer = setInterval(() => {
    if (location.href !== pageUrl) {
      pageUrl = location.href;
      ghostEpoch += 1;
      view.setGhost(null);
      invalidateTarget();
    }
  }, 250);

  function dispose(): void {
    if (disposed) return;
    if (token && !operationId) void request({ v: 1, type: 'CANCEL', token });
    disposed = true;
    generation += 1;
    ghostEpoch += 1;
    clearArmTimers();
    clearTimeout(pollTimer);
    clearTimeout(restoreTimer);
    clearInterval(navigationTimer);
    listeners.abort();
    chrome.runtime.onMessage.removeListener(runtimeListener);
    view.dispose();
    delete sessionWindow.__zombieHandDispose;
  }

  document.addEventListener('pointermove', pointerMove, {
    passive: true,
    signal: listeners.signal,
  });
  document.addEventListener('scroll', invalidateTarget, {
    passive: true,
    capture: true,
    signal: listeners.signal,
  });
  window.addEventListener('resize', invalidateTarget, { passive: true, signal: listeners.signal });
  window.addEventListener('pagehide', dispose, { signal: listeners.signal });
  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted || (view.contains(event) && event.key !== 'Escape')) return;
      if (event.key === 'Escape' && ['arming', 'armed', 'saving'].includes(phase)) {
        event.preventDefault();
        void release();
      }
      if (
        event.altKey &&
        event.shiftKey &&
        event.code === 'KeyZ' &&
        !isEditable(event.target instanceof Element ? event.target : null)
      ) {
        event.preventDefault();
        void captureAccessible();
      }
    },
    { signal: listeners.signal },
  );
  chrome.runtime.onMessage.addListener(runtimeListener);
  void refreshFeatures();
  return dispose;
}

if (
  !sessionWindow.__zombieHandDispose &&
  document.documentElement &&
  /^https?:$/u.test(location.protocol)
)
  sessionWindow.__zombieHandDispose = activate();
