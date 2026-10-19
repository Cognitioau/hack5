// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article","pretendToBeVisual":true}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppResponse, ContentMessage, PublicCapture } from '../../src/core/contracts/index';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (reply: unknown) => void,
) => boolean;
const armToken = '9a049891-c825-405c-9c4d-61df4d2ec0ca';
let runtimeListener: RuntimeListener | undefined;
let shadow: ShadowRoot | undefined;
let target: Element;
let capturedOperation = '';
let deferredCapture: ((value: AppResponse) => void) | undefined;
let delayCapture = false;
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
      text: 'A deliberately captured sentence.',
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

const send = vi.fn(async (message: ContentMessage): Promise<AppResponse> => {
  switch (message.type) {
    case 'CONTENT_STATUS':
      return {
        ok: true,
        features: { images: true, youtube: true, haunting: false, semantic: false, gaze: false },
      };
    case 'ARM':
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
      return { ok: true, capture: record(message.captureId, 'archived', 'queued-local') };
    default:
      return { ok: true };
  }
});

const documentListeners = new Map<string, EventListener>();
function dispatch(type: string, fields: Record<string, unknown>): void {
  const listener = documentListeners.get(type);
  if (!listener) throw new Error(`Missing ${type} listener`);
  listener({
    isTrusted: true,
    target,
    composedPath: () => [target, document],
    preventDefault: vi.fn(),
    ...fields,
  } as unknown as Event);
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
async function accessibleCapture(): Promise<void> {
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
  document.body.innerHTML = '<p id="public">A deliberately captured sentence.</p>';
  target = document.querySelector('#public') as Element;
  currentRect = new DOMRect(40, 50, 240, 80);
  delayCapture = false;
  capturedOperation = '';
  deferredCapture = undefined;
  send.mockClear();
  documentListeners.clear();
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
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
  it('ignores synthetic pointer input, and arms only after the trusted dwell', async () => {
    dispatch('pointermove', { isTrusted: false, pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send.mock.calls.some(([message]) => message.type === 'ARM')).toBe(false);
    dispatch('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(799);
    expect(send.mock.calls.some(([message]) => message.type === 'ARM')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.filter(([message]) => message.type === 'ARM')).toHaveLength(1);
    expect(shadow?.textContent).toContain('Make a little circle.');
  });

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

  it('allows the first eligible ghost search immediately, before the cooldown begins', async () => {
    send.mockImplementationOnce(async () => ({
      ok: true,
      features: { images: true, youtube: true, haunting: true, semantic: false, gaze: false },
    }));
    fromBackground({ v: 1, type: 'SETTINGS_CHANGED' });
    await flush();
    dispatch('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(800);
    expect(
      send.mock.calls.some(
        ([message]) => message.type === 'SEARCH' && message.query.includes('deliberately captured'),
      ),
    ).toBe(true);
  });

  it('keeps a pending cancellation archived despite a late active response or update', async () => {
    delayCapture = true;
    await accessibleCapture();
    dispatch('keydown', { key: 'Escape' });
    await flush();
    expect(
      send.mock.calls.some(
        ([message]) => message.type === 'CANCEL' && message.operationId === capturedOperation,
      ),
    ).toBe(true);
    expect(shadow?.textContent).toContain('Back from the grave.');
    deferredCapture?.({ ok: true, capture: record(capturedOperation) });
    fromBackground({ v: 1, type: 'CAPTURE_UPDATE', capture: record(capturedOperation) });
    await flush();
    expect(shadow?.textContent).not.toContain('Buried, safely.');
  });

  it('does not let a previous save/index update overwrite a newly armed target', async () => {
    await accessibleCapture();
    const previous = capturedOperation;
    await vi.advanceTimersByTimeAsync(650);
    dispatch('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(800);
    fromBackground({ v: 1, type: 'CAPTURE_UPDATE', capture: record(previous) });
    expect(shadow?.textContent).toContain('Make a little circle.');
  });

  it('consumes trailing circle movement after a fast save without starting another arm', async () => {
    await accessibleCapture();
    send.mockClear();
    for (const x of [100, 105, 110, 115]) {
      dispatch('pointermove', { pointerType: 'mouse', clientX: x, clientY: 70 });
      await vi.advanceTimersByTimeAsync(15);
    }
    await vi.advanceTimersByTimeAsync(900);
    expect(send.mock.calls.some(([message]) => message.type === 'ARM')).toBe(false);
    expect(shadow?.textContent).toContain('Buried, safely.');
  });

  it('invalidates the local token and Undo capability when settings change', async () => {
    await accessibleCapture();
    fromBackground({ v: 1, type: 'SETTINGS_CHANGED' });
    await flush();
    expect(shadow?.textContent).toContain('Settings changed.');
    expect(shadow?.querySelector<HTMLButtonElement>('.controls .button:last-child')?.hidden).toBe(
      true,
    );
  });

  it('refuses a screenshot when the target moved or its source changed', async () => {
    document.body.innerHTML =
      '<img id="image" src="https://images.example.org/fern.png" alt="Fern">';
    target = document.querySelector('#image') as Element;
    dispatch('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(800);
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
    dispatch('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(800);
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

  it('uses a shake to cancel the armed target without archiving an earlier capture', async () => {
    await accessibleCapture();
    await vi.advanceTimersByTimeAsync(650);
    dispatch('pointermove', { pointerType: 'mouse', clientX: 80, clientY: 70 });
    await vi.advanceTimersByTimeAsync(800);
    for (const x of [80, 135, 40, 130, 30, 120, 35, 130, 30, 120]) {
      dispatch('pointermove', { pointerType: 'mouse', clientX: x, clientY: 70 });
      await vi.advanceTimersByTimeAsync(70);
    }
    expect(send.mock.calls.some(([message]) => message.type === 'CANCEL')).toBe(true);
    expect(send.mock.calls.some(([message]) => message.type === 'ARCHIVE')).toBe(false);
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
