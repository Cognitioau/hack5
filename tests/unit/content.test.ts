// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article","pretendToBeVisual":true}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppResponse,
  type ContentMessage,
  noVaultMessage,
  type PublicCapture,
} from '../../src/core/contracts/index';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (reply: unknown) => void,
) => boolean;
type Modifier = 'Shift' | 'Control';
const armToken = '9a049891-c825-405c-9c4d-61df4d2ec0ca';
const passage = 'A deliberately captured sentence.';
let runtimeListener: RuntimeListener | undefined;
let shadow: ShadowRoot | undefined;
let target: Element;
let capturedOperation = '';
let deferredArm: ((value: AppResponse) => void) | undefined;
let deferredCapture: ((value: AppResponse) => void) | undefined;
let deferredArchive: ((value: AppResponse) => void) | undefined;
let delayArm = false;
let delayCapture = false;
let delayArchive = false;
let currentRect = new DOMRect(40, 50, 240, 80);

function record(
  id: string,
  lifecycle: 'active' | 'archived' = 'active',
  persistence: PublicCapture['persistence'] = 'saved-vault',
): PublicCapture {
  return {
    schemaVersion: 1,
    id,
    operationId: id,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    candidate: {
      kind: 'text',
      title: 'Fixture',
      text: passage,
      url: 'https://example.org/article',
    },
    lifecycle,
    lifecycleRevision: lifecycle === 'active' ? 0 : 1,
    contentRevision: 0,
    persistence,
    preservation: 'text',
    indexState: 'pending',
  };
}

async function handleMessage(message: ContentMessage): Promise<AppResponse> {
  switch (message.type) {
    case 'CONTENT_STATUS':
      return {
        ok: true,
        features: { images: true, youtube: true, haunting: false, semantic: false, gaze: false },
      };
    case 'ARM':
      if (delayArm)
        return new Promise((resolve) => {
          deferredArm = resolve;
        });
      return { ok: true, token: armToken };
    case 'CAPTURE':
      capturedOperation = message.operationId;
      if (delayCapture)
        return new Promise((resolve) => {
          deferredCapture = resolve;
        });
      return { ok: true, capture: record(message.operationId) };
    case 'CANCEL':
      return message.operationId
        ? { ok: true, capture: record(message.operationId, 'archived', 'queued-local') }
        : { ok: true };
    case 'ARCHIVE':
      if (delayArchive)
        return new Promise((resolve) => {
          deferredArchive = resolve;
        });
      return { ok: true, capture: record(message.captureId, 'archived', 'queued-local') };
    default:
      return { ok: true };
  }
}
const send = vi.fn(handleMessage);
const documentListeners = new Map<string, EventListener>();
function dispatch(type: string, fields: Record<string, unknown> = {}): void {
  const listener = documentListeners.get(type);
  if (!listener) throw new Error(`Missing ${type} listener`);
  listener({
    isTrusted: true,
    target,
    composedPath: () => [target, document],
    preventDefault: vi.fn(),
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    pointerType: 'mouse',
    buttons: 0,
    ...fields,
  } as unknown as Event);
}
function held(modifier: Modifier): { shiftKey: boolean; ctrlKey: boolean } {
  return { shiftKey: modifier === 'Shift', ctrlKey: modifier === 'Control' };
}
function move(x: number, y: number, fields: Record<string, unknown> = {}): void {
  dispatch('pointermove', { clientX: x, clientY: y, ...fields });
}
function beginCircle(modifier: Modifier = 'Shift', fields: Record<string, unknown> = {}): void {
  move(225, 90);
  dispatch('keydown', { key: modifier, ...held(modifier), ...fields });
}
async function traceCircle(
  modifier: Modifier = 'Shift',
  first = 1,
  last = 40,
  fields: Record<string, unknown> = {},
): Promise<void> {
  for (let step = first; step <= last; step += 1) {
    await vi.advanceTimersByTimeAsync(20);
    const angle = (step / 40) * Math.PI * 2;
    move(160 + Math.cos(angle) * 65, 90 + Math.sin(angle) * 65, {
      ...held(modifier),
      ...fields,
    });
  }
  await flush();
}
async function shake(modifier?: Modifier): Promise<void> {
  for (const x of [160, 225, 95, 220, 90, 215, 95, 220]) {
    await vi.advanceTimersByTimeAsync(60);
    move(x, 90, modifier ? held(modifier) : {});
  }
  await flush();
}
function messages(type: ContentMessage['type']): ContentMessage[] {
  return send.mock.calls.map(([message]) => message).filter((message) => message.type === type);
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
async function accessibleCapture(): Promise<void> {
  move(160, 90);
  dispatch('keydown', { key: 'z', code: 'KeyZ', altKey: true, shiftKey: true });
  await flush();
}
function fromBackground(message: unknown): unknown {
  const respond = vi.fn();
  runtimeListener?.(message, { id: 'test-extension' }, respond);
  return respond.mock.calls[0]?.[0];
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('__CORE_ONLY__', false);
  document.title = 'Public fixture';
  document.body.innerHTML =
    '<p id="public">A deliberately captured sentence. A different sentence stays on the page.</p>';
  target = document.querySelector('#public') as Element;
  currentRect = new DOMRect(40, 50, 240, 80);
  shadow = undefined;
  delayArm = false;
  delayCapture = false;
  delayArchive = false;
  capturedOperation = '';
  deferredArm = undefined;
  deferredCapture = undefined;
  deferredArchive = undefined;
  send.mockReset();
  send.mockImplementation(handleMessage);
  documentListeners.clear();
  document.getSelection()?.removeAllRanges();
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: () => ({ offsetNode: target.firstChild, offset: 12 }),
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => currentRect,
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [currentRect],
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => currentRect);
  const originalAttach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = originalAttach.call(this, init);
    if (this.hasAttribute('data-zombie-hand-ui')) shadow = root;
    return root;
  });
  const originalAdd = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (typeof listener === 'function') documentListeners.set(type, listener as EventListener);
    originalAdd(type, listener, options);
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      sendMessage: send,
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          runtimeListener = listener;
        },
        removeListener: (listener: RuntimeListener) => {
          if (runtimeListener === listener) runtimeListener = undefined;
        },
      },
    },
  });
  await import('../../src/bootstrap/content');
  await flush();
});

afterEach(() => {
  (window as Window & { __zombieHandDispose?: () => void }).__zombieHandDispose?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('content interaction lifecycle (mocked browser boundary)', () => {
  it('does not arm or capture while dwelling, circling, or shaking without a modifier', async () => {
    move(225, 90);
    await vi.advanceTimersByTimeAsync(1_200);
    await traceCircle('Shift', 1, 40, { shiftKey: false });
    await shake();
    expect(messages('ARM')).toHaveLength(0);
    expect(messages('CAPTURE')).toHaveLength(0);
  });

  it.each(['Shift', 'Control'] as const)(
    'captures one precise sentence with its source only after a full held-%s circle',
    async (modifier) => {
      beginCircle(modifier);
      await traceCircle(modifier, 1, 25);
      expect(messages('ARM')).toHaveLength(0);
      expect(messages('CAPTURE')).toHaveLength(0);
      await traceCircle(modifier, 26);
      expect(messages('ARM')).toEqual([
        expect.objectContaining({
          candidate: expect.objectContaining({
            kind: 'text',
            text: passage,
            url: document.URL,
            title: 'Public fixture',
          }),
          pageUrl: document.URL,
        }),
      ]);
      expect(messages('CAPTURE')).toHaveLength(1);
      expect(target.textContent).toContain('A different sentence stays on the page.');
    },
  );

  it.each(['key', 'pointer'] as const)('ignores synthetic %s input', async (synthetic) => {
    beginCircle('Shift', synthetic === 'key' ? { isTrusted: false } : {});
    await traceCircle('Shift', 1, 40, synthetic === 'pointer' ? { isTrusted: false } : {});
    expect(messages('ARM')).toHaveLength(0);
    expect(messages('CAPTURE')).toHaveLength(0);
  });

  it.each(['release', 'chord', 'drag', 'scroll', 'blur', 'editable'] as const)(
    'cancels an incomplete circle on %s and requires a fresh modifier press',
    async (reason) => {
      beginCircle();
      await traceCircle('Shift', 1, 12);
      switch (reason) {
        case 'release':
          dispatch('keyup', { key: 'Shift' });
          break;
        case 'chord':
          dispatch('keydown', { key: 'Control', shiftKey: true, ctrlKey: true });
          break;
        case 'drag':
          move(160, 155, { shiftKey: true, buttons: 1 });
          break;
        case 'scroll':
          dispatch('scroll');
          break;
        case 'blur':
          window.dispatchEvent(new Event('blur'));
          break;
        case 'editable': {
          const input = document.createElement('input');
          document.body.append(input);
          dispatch('focusin', { target: input });
          break;
        }
      }
      await traceCircle('Shift', 13);
      dispatch('keydown', { key: 'Shift', shiftKey: true, repeat: true });
      await traceCircle();
      expect(messages('ARM')).toHaveLength(0);
      expect(messages('CAPTURE')).toHaveLength(0);
      dispatch('keyup', { key: 'Shift' });
      beginCircle();
      await traceCircle();
      expect(messages('CAPTURE')).toHaveLength(1);
    },
  );

  it('never begins a gesture or accessible capture from an editable field', async () => {
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    beginCircle('Shift', { target: input });
    await traceCircle();
    dispatch('keydown', {
      key: 'z',
      code: 'KeyZ',
      altKey: true,
      shiftKey: true,
      target: input,
    });
    await flush();
    expect(messages('ARM')).toHaveLength(0);
    expect(messages('CAPTURE')).toHaveLength(0);
  });

  it('consumes repeat keys and trailing circles until the held modifier is released', async () => {
    beginCircle();
    await traceCircle();
    expect(messages('CAPTURE')).toHaveLength(1);
    dispatch('keydown', { key: 'Shift', shiftKey: true, repeat: true });
    await traceCircle();
    expect(messages('ARM')).toHaveLength(1);
    expect(messages('CAPTURE')).toHaveLength(1);
    dispatch('keyup', { key: 'Shift' });
    beginCircle();
    await traceCircle();
    expect(messages('CAPTURE')).toHaveLength(2);
  });

  it('expires a long modifier hold without accepting a later loop in that hold', async () => {
    beginCircle();
    await vi.advanceTimersByTimeAsync(4_600);
    await traceCircle();
    expect(messages('ARM')).toHaveLength(0);
    expect(messages('CAPTURE')).toHaveLength(0);
    dispatch('keyup', { key: 'Shift' });
    beginCircle();
    await traceCircle();
    expect(messages('CAPTURE')).toHaveLength(1);
  });

  it('lets a completed circle finish after key release while ARM is still pending', async () => {
    delayArm = true;
    beginCircle();
    await traceCircle();
    expect(messages('ARM')).toHaveLength(1);
    expect(messages('CAPTURE')).toHaveLength(0);
    dispatch('keyup', { key: 'Shift' });
    deferredArm?.({ ok: true, token: armToken });
    await flush();
    expect(messages('CAPTURE')).toHaveLength(1);
    expect(messages('CANCEL')).toHaveLength(0);
    expect(shadow?.textContent).toContain('Buried, safely.');
  });

  it('lets an accepted capture finish after the modifier is released', async () => {
    delayCapture = true;
    beginCircle();
    await traceCircle();
    expect(messages('CAPTURE')).toHaveLength(1);
    dispatch('keyup', { key: 'Shift' });
    await shake();
    expect(messages('CANCEL')).toHaveLength(0);
    deferredCapture?.({ ok: true, capture: record(capturedOperation) });
    await flush();
    expect(shadow?.textContent).toContain('Buried, safely.');
  });

  it.each(['Escape', 'shake'] as const)(
    'cancels with %s while ARM is pending and revokes a late token',
    async (method) => {
      delayArm = true;
      beginCircle();
      await traceCircle();
      if (method === 'Escape') dispatch('keydown', { key: 'Escape' });
      else await shake('Shift');
      deferredArm?.({ ok: true, token: armToken });
      await flush();
      expect(messages('CAPTURE')).toHaveLength(0);
      expect(messages('CANCEL')).toEqual([
        expect.objectContaining({ token: armToken, type: 'CANCEL' }),
      ]);
      expect(messages('ARCHIVE')).toHaveLength(0);
    },
  );

  it('provides an accessible capture path and waits for a real save acknowledgement', async () => {
    delayCapture = true;
    await accessibleCapture();
    expect(capturedOperation).not.toBe('');
    expect(shadow?.textContent).toContain('Taking hold…');
    expect(shadow?.textContent).not.toContain('Buried, safely.');
    deferredCapture?.({ ok: true, capture: record(capturedOperation) });
    await flush();
    expect(shadow?.textContent).toContain('Buried, safely.');
  });

  it('allows the first eligible ghost search immediately after deliberate confirmation', async () => {
    send.mockImplementationOnce(async () => ({
      ok: true,
      features: { images: true, youtube: true, haunting: true, semantic: false, gaze: false },
    }));
    fromBackground({ v: 1, type: 'SETTINGS_CHANGED' });
    await flush();
    beginCircle();
    await traceCircle('Shift', 1, 25);
    expect(messages('SEARCH')).toHaveLength(0);
    await traceCircle('Shift', 26);
    expect(messages('SEARCH')).toEqual([
      expect.objectContaining({ query: passage, type: 'SEARCH' }),
    ]);
  });

  it('keeps a pending cancellation archived despite a late active response or update', async () => {
    delayCapture = true;
    await accessibleCapture();
    dispatch('keydown', { key: 'Escape' });
    await flush();
    expect(messages('CANCEL')).toEqual([
      expect.objectContaining({ operationId: capturedOperation }),
    ]);
    expect(shadow?.textContent).toContain('Back from the grave.');
    deferredCapture?.({ ok: true, capture: record(capturedOperation) });
    fromBackground({ v: 1, type: 'CAPTURE_UPDATE', capture: record(capturedOperation) });
    await flush();
    expect(shadow?.textContent).not.toContain('Buried, safely.');
  });

  it('does not let a previous save/index update overwrite a new gesture', async () => {
    await accessibleCapture();
    const previous = capturedOperation;
    beginCircle();
    await traceCircle('Shift', 1, 25);
    fromBackground({
      v: 1,
      type: 'CAPTURE_UPDATE',
      capture: record(previous, 'active', 'queued-local'),
    });
    await traceCircle('Shift', 26);
    expect(messages('CAPTURE')).toHaveLength(2);
    expect(capturedOperation).not.toBe(previous);
  });

  it('invalidates a pending token and old Undo capability when settings change', async () => {
    await accessibleCapture();
    delayArm = true;
    beginCircle();
    await traceCircle();
    fromBackground({ v: 1, type: 'SETTINGS_CHANGED' });
    await flush();
    deferredArm?.({ ok: true, token: armToken });
    await flush();
    expect(messages('CAPTURE')).toHaveLength(1);
    expect(messages('CANCEL')).toEqual([expect.objectContaining({ token: armToken })]);
    expect(shadow?.textContent).toContain('Settings changed.');
    await shake('Shift');
    expect(messages('ARCHIVE')).toHaveLength(0);
  });

  it('ignores an old archive failure after settings change and a new gesture begins', async () => {
    beginCircle();
    await traceCircle();
    delayArchive = true;
    await shake('Shift');
    expect(messages('ARCHIVE')).toHaveLength(1);
    fromBackground({ v: 1, type: 'SETTINGS_CHANGED' });
    await flush();
    beginCircle();
    await traceCircle('Shift', 1, 25);
    deferredArchive?.({ ok: false, error: 'An old archive request failed.' });
    await flush();
    expect(shadow?.textContent).not.toContain('An old archive request failed.');
    await traceCircle('Shift', 26);
    expect(messages('CAPTURE')).toHaveLength(2);
  });

  it('refuses a screenshot when the target moved or its source changed', async () => {
    document.body.innerHTML =
      '<img id="image" src="https://images.example.org/fern.png" alt="Fern">';
    target = document.querySelector('#image') as Element;
    delayCapture = true;
    await accessibleCapture();
    currentRect = new DOMRect(40, 70, 240, 80);
    expect(fromBackground({ v: 1, type: 'HIDE_OVERLAY' })).toEqual({ ok: false, valid: false });
    currentRect = new DOMRect(40, 50, 240, 80);
    target.setAttribute('src', 'https://images.example.org/different.png');
    expect(fromBackground({ v: 1, type: 'HIDE_OVERLAY' })).toEqual({ ok: false, valid: false });
  });

  it('acknowledges the actual stable image rectangle only after hiding the overlay', async () => {
    document.body.innerHTML =
      '<img id="image" src="https://images.example.org/fern.png" alt="Fern">';
    target = document.querySelector('#image') as Element;
    delayCapture = true;
    await accessibleCapture();
    const respond = vi.fn();
    expect(
      runtimeListener?.({ v: 1, type: 'HIDE_OVERLAY' }, { id: 'test-extension' }, respond),
    ).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-zombie-hand-ui]')?.style.display).toBe(
      'none',
    );
    await vi.advanceTimersByTimeAsync(40);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        valid: true,
        pageUrl: document.URL,
        currentImageUrl: 'https://images.example.org/fern.png',
        rect: expect.objectContaining({ x: 40, y: 50, width: 240, height: 80 }),
      }),
    );
    fromBackground({ v: 1, type: 'RESTORE_OVERLAY' });
    expect(document.querySelector<HTMLElement>('[data-zombie-hand-ui]')?.style.display).toBe(
      'block',
    );
  });

  it('does not archive a saved capture from ordinary pointer shaking or a new gesture', async () => {
    await accessibleCapture();
    await shake();
    beginCircle();
    await shake('Shift');
    expect(messages('ARCHIVE')).toHaveLength(0);
    expect(messages('CANCEL')).toHaveLength(0);
  });

  it('uses a held-modifier shake to cancel the pending operation, not an earlier capture', async () => {
    await accessibleCapture();
    const previous = capturedOperation;
    delayCapture = true;
    await accessibleCapture();
    const pending = capturedOperation;
    beginCircle();
    await shake('Shift');
    expect(pending).not.toBe(previous);
    expect(messages('CANCEL')).toEqual([expect.objectContaining({ operationId: pending })]);
    expect(messages('ARCHIVE')).toHaveLength(0);
  });

  it('removes its hand once the extension is reloaded under it', async () => {
    expect(document.querySelectorAll('[data-zombie-hand-ui]')).toHaveLength(1);
    (chrome.runtime as { id?: string | undefined }).id = undefined;
    send.mockImplementation(async () => {
      throw new Error('Extension context invalidated.');
    });
    dispatch('pointerdown');
    expect(document.querySelectorAll('[data-zombie-hand-ui]')).toHaveLength(0);
  });

  it('removes its hand when a request finds the extension gone', async () => {
    send.mockImplementation(async () => {
      (chrome.runtime as { id?: string | undefined }).id = undefined;
      throw new Error('Extension context invalidated.');
    });
    const hand = shadow?.querySelector<HTMLButtonElement>('.grab');
    if (!hand) throw new Error('No hand to click');
    hand.click();
    await flush();
    expect(document.querySelectorAll('[data-zombie-hand-ui]')).toHaveLength(0);
  });

  it('replaces a hand left behind by a copy from before a reload', async () => {
    (window as Window & { __zombieHandDispose?: () => void }).__zombieHandDispose?.();
    const stale = document.createElement('div');
    stale.dataset.zombieHandUi = 'true';
    document.documentElement.append(stale);
    vi.resetModules();
    await import('../../src/bootstrap/content');
    await flush();
    const hosts = document.querySelectorAll('[data-zombie-hand-ui]');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).not.toBe(stale);
  });

  it('leaves the hand of the other build profile installed alongside', async () => {
    (window as Window & { __zombieHandDispose?: () => void }).__zombieHandDispose?.();
    const other = document.createElement('div');
    other.dataset.zombieHandUi = 'true';
    other.dataset.zombieHandOwner = 'core';
    document.documentElement.append(other);
    vi.resetModules();
    await import('../../src/bootstrap/content');
    await flush();
    const hosts = [...document.querySelectorAll<HTMLElement>('[data-zombie-hand-ui]')];
    // The mark names the profile, never the extension's id, so pages cannot tell machines apart.
    const markup = document.documentElement.outerHTML;
    other.remove();
    expect(hosts).toHaveLength(2);
    expect(hosts.map((host) => host.dataset.zombieHandOwner)).toEqual(
      expect.arrayContaining(['core', 'full']),
    );
    expect(markup).not.toContain('test-extension');
  });

  it('disposes listeners and timers on deactivation, and ignores foreign runtime messages', async () => {
    const response = vi.fn();
    runtimeListener?.({ v: 1, type: 'DEACTIVATE' }, { id: 'another-extension' }, response);
    expect(document.querySelector('[data-zombie-hand-ui]')).not.toBeNull();
    expect(response).not.toHaveBeenCalled();
    fromBackground({ v: 1, type: 'DEACTIVATE' });
    expect(document.querySelector('[data-zombie-hand-ui]')).toBeNull();
    expect(runtimeListener).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('one-click grabs (mocked browser boundary)', () => {
  const control = (selector: string): HTMLButtonElement =>
    shadow?.querySelector(selector) as HTMLButtonElement;
  function selectPassage(): void {
    const range = document.createRange();
    range.setStart(target.firstChild as Node, 0);
    range.setEnd(target.firstChild as Node, passage.length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }

  it('grabs a live selection with Alt+Shift+Z even when the pointer rests on a control', async () => {
    selectPassage();
    const menu = document.createElement('button');
    menu.textContent = 'Menu';
    document.body.append(menu);
    target = menu;
    await accessibleCapture();
    expect(messages('ARM')[0]).toMatchObject({ candidate: { kind: 'text', text: passage } });
    expect(messages('CAPTURE')).toHaveLength(1);
  });

  it('grabs the selection from the hand button when text is selected', async () => {
    selectPassage();
    control('.grab').click();
    await flush();
    expect(messages('ARM')[0]).toMatchObject({ candidate: { kind: 'text', text: passage } });
    expect(messages('CAPTURE')).toHaveLength(1);
  });

  it('grabs the whole page from the hand button when nothing is selected', async () => {
    document.body.innerHTML =
      '<nav><p>Menu</p></nav><main><h1>Fixture heading</h1><p>Readable body text.</p></main>';
    send.mockImplementation(async (message: ContentMessage) =>
      message.type === 'CAPTURE'
        ? {
            ok: true,
            capture: {
              ...record(message.operationId),
              candidate: {
                kind: 'link',
                title: 'Public fixture',
                text: 'Fixture heading',
                url: 'https://example.org/article',
              },
              preservation: 'link',
            },
          }
        : handleMessage(message),
    );
    control('.grab').click();
    await flush();
    expect(messages('ARM')[0]).toMatchObject({
      candidate: {
        kind: 'link',
        url: 'https://example.org/article',
        title: 'Public fixture',
        text: 'Fixture heading\n\nReadable body text.',
      },
    });
    expect(messages('CAPTURE')).toHaveLength(1);
    expect(shadow?.textContent).toContain('The link and its readable text are saved.');
  });

  it.each([
    ['reads the article', 'loads', undefined],
    ['keeps the excerpt when the reader fails', 'throws', 'Fixture heading\n\nReadable body text.'],
    [
      'keeps the excerpt when the reader cannot be loaded',
      'refused',
      'Fixture heading\n\nReadable body text.',
    ],
  ] as const)('a whole-page grab %s', async (_, reader, excerpt) => {
    document.body.innerHTML =
      '<nav><p>Menu</p></nav><main><h1>Fixture heading</h1><p>Readable body text.</p></main>';
    const global = globalThis as { zombieHandReadArticle?: unknown };
    send.mockImplementation(async (message: ContentMessage) => {
      if (message.type !== 'READ_PAGE') return handleMessage(message);
      if (reader === 'refused') return { ok: false, error: 'Not loaded' };
      global.zombieHandReadArticle = () => {
        if (reader === 'throws') throw new Error('Reader failed');
        return { title: 'The article', text: 'The article text.', byline: { author: 'Ada' } };
      };
      return { ok: true };
    });
    try {
      control('.grab').click();
      await flush();
      expect(messages('READ_PAGE')).toHaveLength(1);
      expect(messages('ARM')[0]).toMatchObject({
        candidate: excerpt
          ? { kind: 'link', wholePage: true, title: 'Public fixture', text: excerpt }
          : {
              kind: 'link',
              wholePage: true,
              title: 'The article',
              text: 'The article text.',
              byline: { author: 'Ada' },
            },
      });
      expect(messages('CAPTURE')).toHaveLength(1);
    } finally {
      delete global.zombieHandReadArticle;
    }
  });

  it('a whole-page grab keeps the page it read, when the page moves on while the reader loads', async () => {
    document.body.innerHTML = '<main><h1>Page A</h1><p>Alpha text of the first page.</p></main>';
    const global = globalThis as { zombieHandReadArticle?: unknown };
    send.mockImplementation(async (message: ContentMessage) => {
      if (message.type !== 'READ_PAGE') return handleMessage(message);
      // A single-page app navigates during the wait.
      history.pushState({}, '', '/page-b');
      document.title = 'Page B';
      document.body.innerHTML = '<main><h1>Page B</h1><p>Bravo text of the second page.</p></main>';
      global.zombieHandReadArticle = (page: Document) => ({
        title: page.title,
        text: page.querySelector('p')?.textContent ?? '',
      });
      return { ok: true };
    });
    try {
      control('.grab').click();
      await flush();
      // The link, the title, the text and the page the background checks all agree.
      expect(messages('ARM')[0]).toMatchObject({
        pageUrl: 'https://example.org/page-b',
        candidate: {
          url: 'https://example.org/page-b',
          title: 'Page B',
          text: 'Bravo text of the second page.',
        },
      });
    } finally {
      delete global.zombieHandReadArticle;
      history.pushState({}, '', '/article');
    }
  });

  it('a whole-page grab still loads the reader when a page element shares its name', async () => {
    document.body.innerHTML =
      '<main><h1>Fixture heading</h1><p>Readable body text.</p></main><div id="zombieHandReadArticle"></div>';
    // A page element by that id shows through the window's named properties,
    // further down its prototype chain, never as the window's own property.
    const named = Object.getPrototypeOf(globalThis) as { zombieHandReadArticle?: unknown };
    Object.defineProperty(named, 'zombieHandReadArticle', {
      configurable: true,
      value: document.getElementById('zombieHandReadArticle'),
    });
    const global = globalThis as { zombieHandReadArticle?: unknown };
    send.mockImplementation(async (message: ContentMessage) => {
      if (message.type !== 'READ_PAGE') return handleMessage(message);
      Object.defineProperty(globalThis, 'zombieHandReadArticle', {
        configurable: true,
        writable: true,
        value: () => ({ title: 'The article', text: 'The article text.' }),
      });
      return { ok: true };
    });
    try {
      control('.grab').click();
      await flush();
      expect(messages('READ_PAGE')).toHaveLength(1);
      expect(messages('ARM')[0]).toMatchObject({ candidate: { title: 'The article' } });
    } finally {
      delete global.zombieHandReadArticle;
      delete named.zombieHandReadArticle;
    }
  });

  it.each([
    ['no vault is connected', 'failed', noVaultMessage, true],
    ['the vault refused the note', 'failed', 'Capture note is too large.', false],
    ['the vault holds a conflicting change', 'conflict', undefined, false],
  ] as const)(
    'lets the hand finish a capture kept when %s, offering settings only where they fix it',
    async (_, persistence, lastError, offered) => {
      send.mockImplementation(async (message: ContentMessage) =>
        message.type === 'CAPTURE'
          ? {
              ok: true,
              capture: {
                ...record(message.operationId, 'active', persistence),
                ...(lastError ? { lastError } : {}),
              },
            }
          : handleMessage(message),
      );
      selectPassage();
      control('.grab').click();
      await flush();
      expect(control('.dock').dataset.state).toBe('error');
      // The vault answered before the hand surfaced; it is still reaching for the words.
      expect(control('.effect').hidden).toBe(false);
      expect(control('.effect').dataset.phase).toBe('reach');
      expect(control('.status').textContent).toBe('Kept on this device.');
      expect(control('.connect').hidden).toBe(!offered);
      if (!offered) return;
      expect(control('.detail').textContent).toBe('Connect a vault to bury it in Obsidian.');
      control('.connect').click();
      await flush();
      expect(messages('OPEN_SETTINGS')).toHaveLength(1);
    },
  );

  /** A grab asked for from the toolbar popup; returns what the page answered. */
  async function toolbarGrab(kind: 'selection' | 'page'): Promise<unknown> {
    const respond = vi.fn();
    expect(runtimeListener?.({ v: 1, type: 'GRAB', kind }, { id: 'test-extension' }, respond)).toBe(
      true,
    );
    await flush();
    expect(respond).toHaveBeenCalledOnce();
    return respond.mock.calls[0]?.[0];
  }

  /** Clicks the hand with nothing selected; the page grab waits on the reader until resolved. */
  async function startSlowPageGrab(
    start = () => control('.grab').click(),
  ): Promise<(reply: AppResponse) => void> {
    const before = messages('READ_PAGE').length;
    let finishRead: ((reply: AppResponse) => void) | undefined;
    send.mockImplementation(async (message: ContentMessage) =>
      message.type === 'READ_PAGE'
        ? new Promise<AppResponse>((resolve) => {
            finishRead = resolve;
          })
        : handleMessage(message),
    );
    start();
    await flush();
    expect(messages('READ_PAGE')).toHaveLength(before + 1);
    return (reply) => finishRead?.(reply);
  }

  it.each([
    ['the keyboard', () => accessibleCapture()],
    [
      'the hand',
      async () => {
        control('.grab').click();
        await flush();
      },
    ],
    [
      'the toolbar',
      async () =>
        expect(await toolbarGrab('selection')).toEqual({
          ok: false,
          error: 'The hand is still holding the last grab.',
        }),
    ],
    [
      'a lasso',
      async () => {
        beginCircle();
        await traceCircle();
        dispatch('keyup', { key: 'Shift' });
      },
    ],
  ] as const)(
    'a grab from %s waits for a whole-page grab still reading the page',
    async (_, grabAgain) => {
      const finishRead = await startSlowPageGrab();
      selectPassage();
      await grabAgain();
      expect(messages('ARM')).toHaveLength(0);
      finishRead({ ok: false, error: 'Not loaded' });
      await flush();
      expect(messages('ARM')).toEqual([
        expect.objectContaining({ candidate: expect.objectContaining({ wholePage: true }) }),
      ]);
      expect(messages('CAPTURE')).toHaveLength(1);
    },
  );

  it.each([
    ['Escape', () => dispatch('keydown', { key: 'Escape' }), 'Let go. Nothing new was captured.'],
    [
      'a settings change',
      () => fromBackground({ v: 1, type: 'SETTINGS_CHANGED' }),
      'Settings changed. Hold Shift or Ctrl and circle a new target; pending captures remain in the graveyard.',
    ],
  ] as const)(
    '%s while the page is read drops that grab, and the hand grabs again at once',
    async (_, interrupt, detail) => {
      const finishRead = await startSlowPageGrab();
      interrupt();
      await flush();
      expect(control('.detail').textContent).toBe(detail);
      selectPassage();
      control('.grab').click();
      await flush();
      expect(messages('ARM')).toEqual([
        expect.objectContaining({ candidate: expect.objectContaining({ text: passage }) }),
      ]);
      // The dropped read comes back late and is dropped.
      finishRead({ ok: false, error: 'Not loaded' });
      await flush();
      expect(messages('ARM')).toHaveLength(1);
    },
  );

  it('a page read let go and outlived by a new one leaves the new one holding', async () => {
    const finishFirst = await startSlowPageGrab();
    dispatch('keydown', { key: 'Escape' });
    await flush();
    const finishSecond = await startSlowPageGrab();
    finishFirst({ ok: false, error: 'Not loaded' });
    await flush();
    selectPassage();
    control('.grab').click();
    await flush();
    expect(messages('ARM')).toHaveLength(0);
    finishSecond({ ok: false, error: 'Not loaded' });
    await flush();
    expect(messages('ARM')).toEqual([
      expect.objectContaining({ candidate: expect.objectContaining({ wholePage: true }) }),
    ]);
  });

  it('never reads a page whose grab was let go while the reader loaded', async () => {
    const global = globalThis as { zombieHandReadArticle?: unknown };
    const reader = vi.fn(() => ({ title: 'The article', text: 'The article text.' }));
    const finishRead = await startSlowPageGrab();
    dispatch('keydown', { key: 'Escape' });
    await flush();
    global.zombieHandReadArticle = reader;
    try {
      finishRead({ ok: true });
      await flush();
      expect(reader).not.toHaveBeenCalled();
      expect(messages('ARM')).toHaveLength(0);
    } finally {
      delete global.zombieHandReadArticle;
    }
  });

  it('tells the toolbar when its page grab was let go while the page was read', async () => {
    const respond = vi.fn();
    const finishRead = await startSlowPageGrab(() =>
      runtimeListener?.({ v: 1, type: 'GRAB', kind: 'page' }, { id: 'test-extension' }, respond),
    );
    dispatch('keydown', { key: 'Escape' });
    await flush();
    finishRead({ ok: false, error: 'Not loaded' });
    await flush();
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'Let go. Nothing new was captured.' });
    expect(messages('ARM')).toHaveLength(0);
  });

  it('keeps the last capture when Spit back is pressed while the page is read', async () => {
    await accessibleCapture();
    expect(control('.archive').hidden).toBe(false);
    const finishRead = await startSlowPageGrab();
    control('.archive').click();
    await flush();
    expect(messages('ARCHIVE')).toHaveLength(0);
    finishRead({ ok: false, error: 'Not loaded' });
    await flush();
    expect(messages('ARM')).toHaveLength(2);
    expect(messages('CAPTURE')).toHaveLength(2);
  });

  it('tells the toolbar why nothing was taken, and takes the selection when there is one', async () => {
    expect(await toolbarGrab('selection')).toEqual({
      ok: false,
      error: 'Select some text on the page first, or grab the whole page.',
    });
    expect(messages('ARM')).toHaveLength(0);
    selectPassage();
    expect(await toolbarGrab('selection')).toEqual({ ok: true });
    expect(messages('ARM')[0]).toMatchObject({ candidate: { kind: 'text', text: passage } });
    expect(messages('CAPTURE')).toHaveLength(1);
  });

  it('takes the page from the toolbar even with text selected', async () => {
    selectPassage();
    expect(await toolbarGrab('page')).toEqual({ ok: true });
    expect(messages('ARM')[0]).toMatchObject({
      candidate: { kind: 'link', url: 'https://example.org/article' },
    });
    expect(messages('CAPTURE')).toHaveLength(1);
  });

  it('passes a refusal back to the toolbar, but counts a capture kept on the device as taken', async () => {
    send.mockImplementation(async (message: ContentMessage) =>
      message.type === 'ARM'
        ? { ok: false, error: 'Zombie Brain is paused everywhere' }
        : handleMessage(message),
    );
    selectPassage();
    expect(await toolbarGrab('selection')).toEqual({
      ok: false,
      error: 'Zombie Brain is paused everywhere',
    });
    expect(messages('CAPTURE')).toHaveLength(0);
    send.mockImplementation(async (message: ContentMessage) =>
      message.type === 'CAPTURE'
        ? {
            ok: true,
            capture: {
              ...record(message.operationId, 'active', 'failed'),
              lastError: noVaultMessage,
            },
          }
        : handleMessage(message),
    );
    expect(await toolbarGrab('selection')).toEqual({ ok: true });
    expect(control('.status').textContent).toBe('Kept on this device.');
  });

  it('offers a selection chip once a selection settles, never mid-drag or for a grabbed selection', async () => {
    const chip = control('.chip');
    expect(chip.hidden).toBe(true);
    dispatch('pointerdown');
    selectPassage();
    dispatch('selectionchange');
    await vi.advanceTimersByTimeAsync(300);
    expect(chip.hidden).toBe(true);
    dispatch('pointerup');
    await vi.advanceTimersByTimeAsync(100);
    expect(chip.hidden).toBe(false);
    expect([chip.style.left, chip.style.top]).toEqual(['286px', '134px']);
    expect(control('.grab').getAttribute('aria-label')).toBe('Grab the selected text');

    chip.click();
    await flush();
    expect(messages('ARM')[0]).toMatchObject({ candidate: { kind: 'text', text: passage } });
    expect(chip.hidden).toBe(true);
    dispatch('scroll');
    await vi.advanceTimersByTimeAsync(300);
    expect(chip.hidden).toBe(true);

    document.getSelection()?.removeAllRanges();
    dispatch('selectionchange');
    await vi.advanceTimersByTimeAsync(300);
    expect(control('.grab').getAttribute('aria-label')).toBe('Grab this page');
    selectPassage();
    dispatch('selectionchange');
    await vi.advanceTimersByTimeAsync(300);
    expect(chip.hidden).toBe(false);
  });
});
