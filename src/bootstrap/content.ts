import {
  type AppResponse,
  type ContentMessage,
  type Features,
  noVaultMessage,
  type PublicCapture,
} from '../core/contracts/index';
import {
  CircleGestureTracker,
  type GestureDecision,
  GestureTracker,
  type GesturePoint,
  stalledMoves,
} from '../core/domain/gestures';
import type { Article } from '../adapters/browser/article';
import {
  extractCandidate,
  extractEnclosed,
  extractPage,
  extractSelection,
  isEditable,
  readingStyle,
  targetRectangle,
  type ExtractedCandidate,
} from '../adapters/browser/extraction';
import { currentVideoSeconds, extractYouTubeCandidate } from '../features/youtube/transcript';
import { HandView, type StateOptions } from '../ui/hand';

type Phase = 'idle' | 'aiming' | 'arming' | 'armed' | 'saving' | 'saved' | 'error';
/** How often, at most, an aimed lasso's highlight follows the loop, in milliseconds. */
const PREVIEW_INTERVAL = 120;
type SessionWindow = Window & { __zombieHandDispose?: () => void };
const sessionWindow = window as SessionWindow;

/** False once the extension is reloaded or removed under this copy of the script. */
const connected = (): boolean => {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

/** Only an explicitly injected content entry installs listeners on a page. */
function activate(): () => void {
  let disposed = false;
  let generation = 0;
  let pageUrl = location.href;
  let phase: Phase = 'idle';
  /** A whole-page grab waiting on the reader: in flight, though nothing is armed yet. */
  let reading = false;
  /** Counts page reads, so one dropped and outlived by the next leaves the next's hold alone. */
  let reads = 0;
  let features: Features = {
    images: false,
    youtube: false,
    haunting: false,
    semantic: false,
    gaze: false,
  };
  let point: GesturePoint = { x: innerWidth / 2, y: innerHeight / 2, at: performance.now() };
  let pointerKnown = false;
  let modifier: 'Shift' | 'Control' | null = null;
  let consumedHold = false;
  let circle: CircleGestureTracker | null = null;
  /** What the loop drawn so far would take, when that was last read, and how long reading took. */
  let preview: ExtractedCandidate | null = null;
  let previewAt = Number.NEGATIVE_INFINITY;
  let previewCost = 0;
  let trail: GesturePoint[] = [];
  let locked: ExtractedCandidate | null = null;
  let token: string | null = null;
  let operationId: string | null = null;
  let tracker: GestureTracker | null = null;
  let gestureTimer: ReturnType<typeof setTimeout> | undefined;
  let armExpiry: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let chipTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerHeld = false;
  /** The selection text just grabbed; its chip stays away until the selection changes. */
  let grabbedSelection: string | null = null;
  let hiddenForSnapshot = false;
  let ghostEpoch = 0;
  let lastGhostAt = Number.NEGATIVE_INFINITY;
  let lastUndo: { captureId: string; until: number } | null = null;
  /** Why the latest attempt took nothing; null once it was kept or the hand moved on. */
  let failure: string | null = null;
  const ownedIds = new Set<string>();
  const cancellationRequested = new Set<string>();
  const acknowledgedSaves = new Set<string>();
  const listeners = new AbortController();

  const request = async (message: ContentMessage): Promise<AppResponse> => {
    try {
      return (await chrome.runtime.sendMessage(message)) as AppResponse;
    } catch {
      // Reloaded or removed: this copy is orphaned, and any new one replaces its hand.
      if (!connected()) dispose();
      return {
        ok: false,
        error: 'The extension connection was interrupted. Reopen Zombie Hand to reconnect.',
      };
    }
  };

  const clearArmTimers = (): void => {
    clearTimeout(gestureTimer);
    clearTimeout(armExpiry);
    gestureTimer = undefined;
    armExpiry = undefined;
  };

  const idle = (
    detail = 'Select text and click the hand, or click it with nothing selected to grab the page. Hold Shift or Ctrl and circle what you want; release early to cancel.',
  ): void => {
    if (disposed) return;
    phase = 'idle';
    circle = null;
    trail = [];
    view.setTrail([]);
    locked = null;
    token = null;
    operationId = null;
    tracker = lastUndo ? new GestureTracker(point) : null;
    view.setUndoAvailable(lastUndo !== null);
    view.setTarget(null);
    view.setState('idle', 'Ready when you are.', detail);
  };

  const showError = (detail: string, options: StateOptions = {}): void => {
    phase = 'error';
    failure = options.kept ? null : detail;
    circle = null;
    trail = [];
    view.setTrail([]);
    view.setTarget(null);
    view.setState(
      'error',
      options.kept ? 'Kept on this device.' : 'The hand slipped.',
      detail,
      options,
    );
  };

  const renderCapture = (capture: PublicCapture): void => {
    if (disposed || !ownedIds.has(capture.id)) return;
    if (cancellationRequested.has(capture.id) && capture.lifecycle !== 'archived') return;
    if (phase === 'aiming' || phase === 'arming' || phase === 'armed') return;
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
            : capture.candidate.kind === 'link'
              ? 'The link and its readable text are saved.'
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
        `${preservation}${transcriptDetail} Source title and link included. Spit back undoes this capture.`,
      );
      return;
    }
    if (capture.persistence === 'queued-local' || capture.persistence === 'uncertain') {
      phase = 'saving';
      view.setState(
        'saving',
        capture.persistence === 'uncertain' ? 'Waiting for a receipt.' : 'Held in the hand.',
        capture.persistence === 'uncertain'
          ? 'The vault response was uncertain. Kept locally while the write is reconciled. Escape cancels.'
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
    const noVault = capture.lastError === noVaultMessage;
    showError(
      capture.persistence === 'conflict'
        ? 'The vault has a conflicting change; review it in the graveyard.'
        : noVault
          ? 'Connect a vault to bury it in Obsidian.'
          : capture.lastError || 'The vault save failed. Check the connection in the graveyard.',
      { kept: true, settings: noVault },
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
    const epoch = ++generation;
    // A page still being read is let go now; its read is dropped when it returns.
    reading = false;
    ghostEpoch += 1;
    view.setGhost(null);
    circle = null;
    trail = [];
    consumedHold = true;
    view.setTrail([]);
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
    if (disposed || epoch !== generation) return;
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
    if (!lastUndo || disposed || reading || ['aiming', 'arming', 'armed', 'saving'].includes(phase))
      return;
    const captureId = lastUndo.captureId;
    const epoch = ++generation;
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
    if (disposed || epoch !== generation) return;
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
      'Preparing a durable local capture. Keep the modifier held and shake, or press Escape to cancel.',
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

  const candidateAt = (
    preferSelection = false,
    position: { x: number; y: number } = point,
  ): ExtractedCandidate | null => {
    const extracted = extractCandidate(document, position, {
      preferSelection,
      ...(!__CORE_ONLY__ && features.youtube ? { special: extractYouTubeCandidate } : {}),
    });
    if (extracted?.candidate.kind === 'image' && !features.images) return null;
    return extracted;
  };

  /** What a lasso's loop takes, centred where the loop is. */
  const enclosedBy = (
    loop: readonly GesturePoint[],
    centre: { x: number; y: number },
  ): ExtractedCandidate | null => {
    const extracted = extractEnclosed(document, loop, centre, {
      images: features.images,
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

  const arm = async (
    candidate: ExtractedCandidate,
    captureImmediately = false,
    whole: 'page' | 'text' = 'text',
  ): Promise<void> => {
    if (disposed || phase === 'saving') return;
    clearArmTimers();
    const epoch = ++generation;
    phase = 'arming';
    if (lastUndo) lastUndo.until = 0;
    locked = candidate;
    const frozenPage = location.href;
    view.setUndoAvailable(false);
    const style = readingStyle(candidate.target, document);
    view.setTarget(
      candidate.rectangle,
      whole === 'page'
        ? candidate.candidate.title
        : candidate.candidate.text || candidate.candidate.title,
      candidate.rectangles,
      {
        kind: whole,
        detail: location.hostname,
        ...(style ? { style } : {}),
        ...(candidate.highlight ? { highlight: candidate.highlight } : {}),
      },
    );
    view.setState(
      'arming',
      whole === 'page' ? 'Taking this page…' : 'Taking this passage…',
      whole === 'page'
        ? 'Locking the page title, link and readable text…'
        : 'Locking the highlighted evidence and its source…',
    );
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
    tracker = new GestureTracker(point);
    view.setState(
      'armed',
      'Target confirmed.',
      candidate.candidate.kind === 'youtube' &&
        candidate.candidate.video?.transcript.cues.length === 0
        ? 'Open Show transcript before your next capture to include available captions.'
        : whole === 'page'
          ? 'The page title, link and readable text are ready to capture.'
          : 'The highlighted passage and its source are ready to capture.',
    );
    armExpiry = setTimeout(() => {
      void release();
    }, 25_000);
    askGhost(candidate);
    if (captureImmediately) await confirm();
  };

  /** Clears any unfinished lasso; false while an earlier grab is still in flight. */
  const beginManualGrab = async (): Promise<boolean> => {
    if (phase === 'armed') {
      await confirm();
      return false;
    }
    if (reading || phase === 'saving' || phase === 'arming') return false;
    clearArmTimers();
    circle = null;
    trail = [];
    consumedHold = true;
    view.setTrail([]);
    return true;
  };

  const grabSelected = async (candidate: ExtractedCandidate): Promise<void> => {
    grabbedSelection = candidate.candidate.text;
    await arm(candidate, true);
  };

  /** The page's readable article, from the reader the background loads on demand. */
  const readArticle = async (wanted: () => boolean): Promise<Article | null> => {
    // Only what page-reader.js set: a page element with that id shows through
    // the window's named properties, never as its own property.
    const reader = (): ((page: Document) => Article | null) | undefined => {
      const own = Object.getOwnPropertyDescriptor(globalThis, 'zombieHandReadArticle')?.value;
      return typeof own === 'function' ? own : undefined;
    };
    try {
      if (!reader() && !(await request({ v: 1, type: 'READ_PAGE' })).ok) return null;
      // A grab dropped while the reader loaded is not read at all.
      return wanted() ? (reader()?.(document) ?? null) : null;
    } catch {
      // The reader improves a page grab but is never required: the excerpt still saves.
      return null;
    }
  };

  /** `dropped` when Escape, a settings change or the hand going away let go while the page was read. */
  const grabPage = async (): Promise<'dropped' | undefined> => {
    const refuse = (): undefined => {
      showError('This page cannot be grabbed. Only public http(s) pages are captured.');
      return undefined;
    };
    if (!extractPage(document)) return refuse();
    const epoch = generation;
    const wanted = (): boolean => !disposed && epoch === generation;
    const read = ++reads;
    reading = true;
    let article: Article | null;
    try {
      article = await readArticle(wanted);
    } finally {
      if (read === reads) reading = false;
    }
    if (!wanted()) return 'dropped';
    // Taken after the wait, with the reader's read: a page that moved on
    // meanwhile is the one both describe, and the one its link points to.
    const page = extractPage(document);
    if (!page) return refuse();
    const { truncated: _excerptCut, ...excerpt } = page.candidate;
    const candidate = article
      ? { ...excerpt, ...article, wholePage: true as const }
      : { ...page.candidate, wholePage: true as const };
    await arm({ ...page, candidate }, true, 'page');
    return undefined;
  };

  /** Alt+Shift+Z: the selection wherever the pointer is, else what the pointer is on. */
  const captureAccessible = async (): Promise<void> => {
    if (!(await beginManualGrab())) return;
    const candidate = candidateAt(true);
    if (!candidate) {
      showError(
        'Select page text or point at a phrase, image or video first. Click the hand to grab the whole page.',
      );
      return;
    }
    if (candidate.candidate.kind === 'text') grabbedSelection = candidate.candidate.text;
    await arm(candidate, true);
  };

  const captureSelection = async (): Promise<void> => {
    if (!(await beginManualGrab())) return;
    const selected = extractSelection(document);
    if (!selected) {
      showError('Select some page text first, or click the hand to grab the whole page.');
      return;
    }
    await grabSelected(selected);
  };

  /** The hand button: the selection when there is one, otherwise the page. */
  const grab = async (): Promise<void> => {
    if (!(await beginManualGrab())) return;
    const selected = extractSelection(document);
    if (selected) await grabSelected(selected);
    else await grabPage();
  };

  /** A grab asked for from the toolbar popup, which shows why nothing was taken. */
  const grabFromToolbar = async (whole: boolean): Promise<AppResponse> => {
    const selected = whole ? null : extractSelection(document);
    if (!whole && !selected)
      return { ok: false, error: 'Select some text on the page first, or grab the whole page.' };
    if (reading || phase === 'saving' || phase === 'arming')
      return { ok: false, error: 'The hand is still holding the last grab.' };
    failure = null;
    // An armed lasso target is taken as it stands.
    if (!(await beginManualGrab())) return { ok: true };
    if (selected) await grabSelected(selected);
    else if ((await grabPage()) === 'dropped')
      return { ok: false, error: 'Let go. Nothing new was captured.' };
    return phase === 'error' && failure ? { ok: false, error: failure } : { ok: true };
  };

  const showSelectionChip = (): void => {
    chipTimer = undefined;
    if (disposed) return;
    const selected = extractSelection(document);
    if (!selected) grabbedSelection = null;
    const end = selected?.rectangles?.[selected.rectangles.length - 1] ?? selected?.rectangle;
    const point = end ? { x: end.x + end.width, y: end.y + end.height } : null;
    const usable =
      point !== null &&
      !pointerHeld &&
      !hiddenForSnapshot &&
      ['idle', 'saved', 'error'].includes(phase) &&
      selected?.candidate.text !== grabbedSelection &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= innerWidth &&
      point.y <= innerHeight;
    view.setSelectionChip(usable ? point : null, selected !== null);
  };

  const scheduleSelectionChip = (delay = 160): void => {
    clearTimeout(chipTimer);
    chipTimer = setTimeout(showSelectionChip, delay);
  };

  /** The background hands over a packaged hand as bytes; decoding them needs no URL the page CSP could block. */
  const loadSprite = async (hand: number): Promise<Uint8Array<ArrayBuffer> | null> => {
    const response = await request({ v: 1, type: 'HAND_SPRITE', hand });
    if (!response.ok || !response.sprite) return null;
    // An indexed loop: Uint8Array.from with a mapper stalls the page ~60 ms per hand.
    const text = atob(response.sprite);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
    return bytes;
  };

  // A copy injected before the extension was reloaded leaves its hand behind,
  // cut off from the extension; the page keeps one hand, this one. The other build
  // profile installed alongside keeps its own (hands from before owners were marked
  // go too). Hands are marked by profile, never by the extension's id, which for an
  // unpacked build comes from its folder and would let pages tell machines apart.
  const owner = __CORE_ONLY__ ? 'core' : 'full';
  for (const stale of document.querySelectorAll<HTMLElement>('[data-zombie-hand-ui]'))
    if ((stale.dataset.zombieHandOwner ?? owner) === owner) stale.remove();
  const view = new HandView(document, {
    capture: () => {
      void captureSelection();
    },
    grab: () => {
      void grab();
    },
    cancel: () => {
      void release();
    },
    archive: () => {
      void archive();
    },
    settings: () => {
      void request({ v: 1, type: 'OPEN_SETTINGS' });
    },
    sprite: loadSprite,
  });
  view.host.dataset.zombieHandOwner = owner;

  // A modifier hold owns exactly one lasso. Its release never cancels a
  // completed circle that is already crossing the asynchronous message boundary.
  const endInput = (invalidatePending = false): void => {
    modifier = null;
    consumedHold = false;
    circle = null;
    trail = [];
    clearTimeout(gestureTimer);
    view.setTrail([]);
    if (phase === 'aiming') idle();
    else if (invalidatePending && (phase === 'arming' || phase === 'armed')) void release();
  };

  const beginCircle = (): void => {
    if (phase === 'arming' || phase === 'armed') return;
    consumedHold = reading || phase === 'saving';
    tracker = new GestureTracker(point);
    if (consumedHold) return;
    circle = new CircleGestureTracker();
    preview = null;
    previewAt = Number.NEGATIVE_INFINITY;
    previewCost = 0;
    trail = [];
    phase = 'aiming';
    view.setUndoAvailable(false);
    view.setGhost(null);
    ghostEpoch += 1;
    view.setTarget(null);
    view.setState(
      'armed',
      'Circle the words.',
      'Close a loop around what you want. Release the key or press Escape to cancel.',
    );
    if (pointerKnown) {
      const first = { ...point, at: performance.now() };
      circle.add(first);
      trail.push(first);
    }
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(() => {
      if (phase !== 'aiming') return;
      consumedHold = true;
      idle('Circle expired. Release the key, then hold Shift or Ctrl to try again.');
    }, 4_500);
  };

  const pointerMove = (event: PointerEvent): void => {
    if (!event.isTrusted || disposed || hiddenForSnapshot || view.contains(event)) return;
    if (event.pointerType === 'touch') {
      endInput();
      return;
    }
    point = { x: event.clientX, y: event.clientY, at: performance.now() };
    pointerKnown = true;
    view.move(point.x, point.y);
    if (!modifier) return;
    const singleModifier =
      modifier === 'Shift' ? event.shiftKey && !event.ctrlKey : event.ctrlKey && !event.shiftKey;
    if (
      !singleModifier ||
      event.altKey ||
      event.metaKey ||
      event.buttons !== 0 ||
      isEditable(event.target instanceof Element ? event.target : null) ||
      isEditable(document.activeElement)
    ) {
      endInput();
      return;
    }
    if (consumedHold) {
      if (tracker?.add(point, false) === 'cancel') {
        if (phase === 'arming' || phase === 'armed' || (phase === 'saving' && token))
          void release();
        else if (lastUndo && point.at <= lastUndo.until && phase === 'saved') void archive();
      }
      return;
    }
    if (phase !== 'aiming' || !circle) return;
    // After the page was busy, as reading the highlight makes it, the moves
    // made meanwhile come merged into this one; tracing them keeps the loop.
    const merged = stalledMoves(
      (event.getCoalescedEvents?.() ?? []).map((move) => ({
        x: move.clientX,
        y: move.clientY,
        at: move.timeStamp,
      })),
      trail.at(-1)?.at ?? point.at,
      point.at,
    );
    let decision: GestureDecision = 'none';
    for (const move of [...merged, point]) {
      trail.push(move);
      decision = circle.add(move);
      if (decision !== 'none') break;
    }
    trail = trail.slice(-256);
    view.setTrail(trail);
    const center = circle.getCenter();
    // Reading every word in a loop costs more than reading the sentence at a
    // point, and on a page of many thousands of elements far more, so the
    // highlight follows the loop a few times a second, never spending more
    // than a fifth of the time on it. A closed loop is always read afresh.
    if (
      decision === 'confirm' ||
      point.at - previewAt >= Math.max(PREVIEW_INTERVAL, previewCost * 4)
    ) {
      const started = performance.now();
      preview = center ? enclosedBy(circle.getLoop(), center) : null;
      previewAt = performance.now();
      previewCost = previewAt - started;
    }
    const candidate = preview;
    view.setTarget(
      candidate?.rectangle ?? null,
      candidate?.candidate.text || candidate?.candidate.title || '',
      candidate?.rectangles,
    );
    if (decision === 'cancel') {
      consumedHold = true;
      clearArmTimers();
      idle('Let go. Nothing new was captured.');
    } else if (decision === 'confirm') {
      consumedHold = true;
      circle = null;
      trail = [];
      clearArmTimers();
      view.setTrail([]);
      if (!candidate) {
        showError(
          'Nothing to take inside that loop. Circle text, a picture or a video; form fields are left out.',
        );
        return;
      }
      void arm(candidate, true);
    }
  };

  const invalidateTarget = (): void => endInput(true);

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
        reading = false;
        endInput();
        clearArmTimers();
        clearTimeout(pollTimer);
        lastUndo = null;
        ownedIds.clear();
        cancellationRequested.clear();
        acknowledgedSaves.clear();
        // Changing settings invalidates background capabilities, including the
        // token for an already armed target. Durable work stays in the journal.
        idle(
          'Settings changed. Hold Shift or Ctrl and circle a new target; pending captures remain in the graveyard.',
        );
        void refreshFeatures();
        sendResponse({ ok: true });
        return false;
      case 'DEACTIVATE':
        dispose();
        sendResponse({ ok: true });
        return false;
      case 'GRAB':
        void grabFromToolbar((message as { kind?: unknown }).kind === 'page').then(sendResponse);
        return true;
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
    disposed = true;
    if (token && !operationId) void request({ v: 1, type: 'CANCEL', token });
    generation += 1;
    ghostEpoch += 1;
    clearArmTimers();
    clearTimeout(pollTimer);
    clearTimeout(restoreTimer);
    clearTimeout(chipTimer);
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
  // Moving the page invalidates a target; the selection chip steps aside and returns.
  const pageMoved = (): void => {
    invalidateTarget();
    view.setSelectionChip(null, document.getSelection()?.isCollapsed === false);
    scheduleSelectionChip(220);
  };
  document.addEventListener('scroll', pageMoved, {
    passive: true,
    capture: true,
    signal: listeners.signal,
  });
  window.addEventListener('resize', pageMoved, { passive: true, signal: listeners.signal });
  document.addEventListener(
    'selectionchange',
    () => {
      if (pointerHeld) view.setSelectionChip(null, false);
      else scheduleSelectionChip();
    },
    { signal: listeners.signal },
  );
  const pointerReleased = (event: PointerEvent): void => {
    if (!event.isTrusted || !pointerHeld) return;
    pointerHeld = false;
    scheduleSelectionChip(60);
  };
  document.addEventListener('pointerup', pointerReleased, {
    passive: true,
    signal: listeners.signal,
  });
  document.addEventListener('pointercancel', pointerReleased, {
    passive: true,
    signal: listeners.signal,
  });
  window.addEventListener('pagehide', dispose, { signal: listeners.signal });
  window.addEventListener('blur', invalidateTarget, { signal: listeners.signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!connected()) dispose();
      else if (document.hidden) invalidateTarget();
    },
    { signal: listeners.signal },
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!connected()) {
        dispose();
        return;
      }
      if (!event.isTrusted || view.contains(event)) return;
      pointerHeld = true;
      endInput(true);
    },
    { passive: true, signal: listeners.signal },
  );
  document.addEventListener(
    'focusin',
    (event) => {
      if (isEditable(event.target instanceof Element ? event.target : null)) invalidateTarget();
    },
    { signal: listeners.signal },
  );
  document.addEventListener(
    'keyup',
    (event) => {
      if (event.isTrusted && event.key === modifier) endInput();
    },
    { signal: listeners.signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (!connected()) {
        dispose();
        return;
      }
      if (!event.isTrusted || (view.contains(event) && event.key !== 'Escape')) return;
      if (
        event.key === 'Escape' &&
        (reading || ['aiming', 'arming', 'armed', 'saving'].includes(phase))
      ) {
        event.preventDefault();
        void release();
        return;
      }
      const editable =
        isEditable(event.target instanceof Element ? event.target : null) ||
        isEditable(document.activeElement);
      if (
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === 'KeyZ' &&
        !editable
      ) {
        event.preventDefault();
        if (!event.repeat) void captureAccessible();
        return;
      }
      if (event.repeat) return;
      const singleModifier =
        (event.key === 'Shift' && event.shiftKey && !event.ctrlKey) ||
        (event.key === 'Control' && event.ctrlKey && !event.shiftKey);
      if (!singleModifier || event.altKey || event.metaKey || editable) {
        endInput();
        return;
      }
      if (modifier) return;
      modifier = event.key as 'Shift' | 'Control';
      beginCircle();
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
