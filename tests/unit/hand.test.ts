// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article","pretendToBeVisual":true}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../src/core/contracts/index';
import { GRAVE_SPRITE } from '../../src/ui/grave-sprite';
import { HandView } from '../../src/ui/hand';

let shadow: ShadowRoot;
let view: HandView;
const actions = {
  capture: vi.fn(),
  cancel: vi.fn(),
  archive: vi.fn(),
  close: vi.fn(),
  page: vi.fn(),
};
const rectangle = {
  x: 120,
  y: 200,
  width: 250,
  height: 65,
  viewportWidth: 800,
  viewportHeight: 600,
};

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = shadow.querySelector<T>(selector);
  if (!result) throw new Error(`Missing view element: ${selector}`);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<p id="source">The original passage stays on the page.</p>';
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const result = attachShadow.call(this, init);
    if (this.hasAttribute('data-zombie-hand-ui')) shadow = result;
    return result;
  });
  view = new HandView(document, actions);
});

afterEach(() => {
  view.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('target-local hand presentation', () => {
  it('keeps ordinary cursor movement quiet and secondary controls explicitly expandable', () => {
    view.move(180, 230);
    expect(element('.effect').hidden).toBe(true);
    expect(element('.panel').hidden).toBe(true);
    expect(shadow.querySelector('.cursor')).toBeNull();
    element('.toggle').click();
    expect(element('.toggle').getAttribute('aria-expanded')).toBe('true');
    expect(element('.panel').hidden).toBe(false);
    const savePage = [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save page',
    );
    savePage?.click();
    expect(actions.page).toHaveBeenCalledOnce();
    element('.close').click();
    expect(actions.close).toHaveBeenCalledOnce();
  });

  it('renders untrusted snippet copies as text and never alters the source passage', () => {
    const malicious = '<img src=x onerror="alert(1)"> & a source quotation';
    view.setTarget(rectangle, malicious, [
      { x: 125, y: 205, width: 190, height: 20 },
      { x: 125, y: 230, width: 240, height: 20 },
    ]);
    view.setState('saving', 'Queued locally.', 'Waiting for the vault response.');
    expect(shadow.querySelectorAll('.target')).toHaveLength(2);
    expect(element('.grabbed').textContent).toBe(malicious);
    expect(shadow.querySelector('img')).toBeNull();
    expect(document.querySelector('#source')?.textContent).toBe(
      'The original passage stays on the page.',
    );
    expect(element('[role="status"]').textContent).toBe(
      'Queued locally. Waiting for the vault response.',
    );
    expect(element('.effect').hidden).toBe(false);
    expect(element('.title').textContent).not.toContain('Saved');
  });

  it('preserves the capture animation after target removal but never hides a newer capture', async () => {
    view.setTarget(rectangle, 'First capture');
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    view.setTarget(null);
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    expect(element('.effect').hidden).toBe(false);
    expect(element('.grabbed').textContent).toBe('First capture');
    await vi.advanceTimersByTimeAsync(300);
    view.setTarget({ ...rectangle, x: 320 }, 'New capture');
    view.setState('armed', 'Circle the words.', 'Only highlighted text will be captured.');
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(element('.effect').hidden).toBe(false);
    expect(element('.effect').dataset.phase).toBe('reach');
    expect(element('.grabbed').textContent).toBe('New capture');
    view.setState('error', 'Still local.', 'The vault has not acknowledged this capture.');
    await vi.advanceTimersByTimeAsync(500);
    expect(element('.effect').hidden).toBe(true);
    expect(element('.title').textContent).toBe('Still local.');
  });

  it('decodes the hand atlas once per page and draws the rendered frame for each pose', async () => {
    const atlas = { width: 1090, height: 1784 } as unknown as CanvasImageSource;
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ clearRect: vi.fn(), drawImage }) as unknown as CanvasRenderingContext2D,
    );
    const sprite = vi
      .fn<() => Promise<CanvasImageSource | null>>()
      .mockRejectedValueOnce(new Error('Synthetic interrupted read'))
      .mockResolvedValue(atlas);
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    view.setTarget(rectangle, 'A failed read is retried');
    await vi.advanceTimersByTimeAsync(0);
    view.setTarget(rectangle, 'Decoded while the user confirms');
    await vi.advanceTimersByTimeAsync(0);
    view.setTarget(rectangle, 'Never decoded twice');
    expect(sprite).toHaveBeenCalledTimes(2);
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    const { frame, columns } = GRAVE_SPRITE;
    // The first frame of the rise: fingers bunched to punch through.
    expect(drawImage).toHaveBeenLastCalledWith(
      atlas,
      0,
      0,
      frame.width,
      frame.height,
      0,
      0,
      frame.width,
      frame.height,
    );
    const fist = GRAVE_SPRITE.rise + GRAVE_SPRITE.grab - 1;
    // jsdom has no matchMedia; this view prefers reduced motion.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    view.setState('armed', 'Circle the words.', 'Only highlighted text will be captured.');
    view.setTarget(rectangle, 'Reduced motion holds the closed fist');
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    expect(drawImage).toHaveBeenLastCalledWith(
      atlas,
      (fist % columns) * frame.width,
      Math.floor(fist / columns) * frame.height,
      frame.width,
      frame.height,
      0,
      0,
      frame.width,
      frame.height,
    );
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('keeps undo accessible while collapsed and suppresses it during a different pending capture', () => {
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    view.setUndoAvailable(true);
    expect(element('.panel').hidden).toBe(true);
    expect(element('.archive').hidden).toBe(false);
    element('.archive').click();
    expect(actions.archive).toHaveBeenCalledOnce();
    view.setState('armed', 'Circle the words.', 'Only this target.');
    view.setUndoAvailable(true);
    expect(element('.archive').hidden).toBe(true);
    expect(element('.cancel').hidden).toBe(false);
  });

  it('uncovers the source while an offline save remains truthfully queued', async () => {
    view.setTarget(rectangle, 'The saved copy is still only local.');
    view.setState('saving', 'Queued locally.', 'Waiting for the vault connection.');
    await vi.advanceTimersByTimeAsync(2_200);
    expect(element('.effect').hidden).toBe(true);
    expect(element('.dock').dataset.state).toBe('saving');
    expect(element('.title').textContent).toBe('Queued locally.');
    expect(element('.detail').textContent).toBe('Waiting for the vault connection.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not grab an old passage again when archiving its completed capture', async () => {
    view.setTarget(rectangle, 'An earlier passage');
    view.setState('saving', 'Taking hold…', 'Queued locally.');
    view.setTarget(null);
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    await vi.advanceTimersByTimeAsync(1_500);
    view.setState('saving', 'Spitting it back…', 'Archiving the latest capture.');
    expect(element('.effect').hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hides every screenshot overlay and disposes pending animation work and listeners', async () => {
    view.setTarget(rectangle, 'Synthetic screenshot target');
    view.setTrail([
      { x: 140, y: 210 },
      { x: 160, y: 220 },
    ]);
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    view.setHidden(true);
    expect(view.host.style.getPropertyValue('display')).toBe('none');
    expect(view.host.style.getPropertyPriority('display')).toBe('important');
    view.setHidden(false);
    expect(view.host.style.getPropertyValue('display')).toBe('block');
    const close = element('.close');
    view.dispose();
    expect(view.host.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    close.click();
    expect(actions.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(element('.effect').hidden).toBe(true);
  });

  it('keeps related notes behind the compact indicator and rejects executable links', () => {
    const ghost: SearchResult = {
      capture: {
        schemaVersion: 1,
        id: '9a049891-c825-405c-9c4d-61df4d2ec0ca',
        operationId: '9a049891-c825-405c-9c4d-61df4d2ec0ca',
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
        candidate: {
          kind: 'text',
          title: '<b>Source title</b>',
          text: 'A note.',
          url: 'https://example.org/note',
        },
        lifecycle: 'active',
        lifecycleRevision: 0,
        contentRevision: 0,
        persistence: 'saved-vault',
        preservation: 'text',
        indexState: 'pending',
      },
      score: 1,
      excerpt: '<img src=x onerror=alert(1)>',
      sourceUrl: 'https://example.org/note',
      mode: 'keyword',
    };
    view.setGhost(ghost);
    expect(element('.ghost').hidden).toBe(true);
    expect(element('.ghost-indicator').hidden).toBe(false);
    element('.toggle').click();
    expect(element('.ghost').hidden).toBe(false);
    expect(element('.ghost a').textContent).toBe('<b>Source title</b>');
    expect(shadow.querySelector('img')).toBeNull();
    view.setGhost({ ...ghost, sourceUrl: 'javascript:alert(1)' });
    expect(element('.ghost').hidden).toBe(true);
    expect(element('.ghost a').hasAttribute('href')).toBe(false);
  });
});
