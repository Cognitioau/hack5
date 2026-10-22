// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article","pretendToBeVisual":true}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../src/core/contracts/index';
import { grabEndFor } from '../../src/ui/grave';
import { GRAVE_HANDS } from '../../src/ui/grave-sprite';
import { HandView } from '../../src/ui/hand';

let shadow: ShadowRoot;
let view: HandView;
const actions = {
  capture: vi.fn(),
  cancel: vi.fn(),
  archive: vi.fn(),
};
const rectangle = {
  x: 120,
  y: 200,
  width: 250,
  height: 65,
  viewportWidth: 800,
  viewportHeight: 600,
};

/** Steps of cracks before the first footage frame. */
const PRE = 5;

interface FakeFrame {
  frame: number;
  close: () => void;
}
let frames: FakeFrame[] = [];

/** A synthetic packaged hand: frame `n` is a bare RIFF WEBP chunk of 12 + 2n bytes. */
function packedHand(count: number): Uint8Array<ArrayBuffer> {
  const parts = Array.from({ length: count }, (_, index) => {
    const bytes = new Uint8Array(12 + index * 2);
    bytes.set([82, 73, 70, 70]);
    new DataView(bytes.buffer).setUint32(4, 4 + index * 2, true);
    bytes.set([87, 69, 66, 80], 8);
    return [...bytes];
  });
  return new Uint8Array(parts.flat());
}

/**
 * 2D contexts that record drawImage, a decoder that names each packed frame by
 * its size, and the offscreen canvas that lays each one's hand over its wall.
 * `size` is each packed frame's layer size; a test may set it once a hand is picked.
 */
function fakeCanvas(size = { width: 1, height: 1 }) {
  const drawn: Record<string | symbol, unknown> = {};
  // Each image laid on a canvas: its frame, how it was composited, and when.
  const layers: { frame: number; mode: string; alpha: number; at: number }[] = [];
  const drawImage = vi.fn((image: FakeFrame) => {
    layers.push({
      frame: image.frame,
      mode: String(drawn.globalCompositeOperation ?? 'source-over'),
      alpha: Number(drawn.globalAlpha ?? 1),
      at: performance.now(),
    });
  });
  drawn.drawImage = drawImage;
  // Every colour stroked, filled or put in a gradient on the effect's canvases.
  const colours: string[] = [];
  const context = new Proxy<Record<string | symbol, unknown>>(drawn, {
    get: (target, key) => {
      target[key] ??= vi.fn(() => ({
        addColorStop: (_offset: number, colour: string) => colours.push(colour),
      }));
      return target[key];
    },
    set: (target, key, value) => {
      if ((key === 'strokeStyle' || key === 'fillStyle') && typeof value === 'string')
        colours.push(value);
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  frames = [];
  const packed: FakeFrame[] = [];
  const decode = vi.fn(async (blob: Blob) => {
    const frame = {
      frame: (blob.size - 12) / 2,
      close: vi.fn(),
      width: size.width * 2,
      height: size.height,
    };
    packed.push(frame);
    return frame as unknown as ImageBitmap;
  });
  Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: decode });
  // What each laid frame was made of, in order: the wall half, its pixels read
  // back and tinted (to its first pixel's values, from a wall of 200s), then the
  // hand half; and, for each tinted wall, the box around its pixels that came
  // out clearly lighter than its corner.
  const laid: (string | number[])[][] = [];
  const lit: { left: number; top: number; right: number; bottom: number }[] = [];
  class Layers {
    private last = -1;
    private steps: (string | number[])[] = [];
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return {
        clearRect: vi.fn(),
        drawImage: (image: FakeFrame, sx: number) => {
          this.last = image.frame;
          this.steps.push(sx === 0 ? 'hand' : 'wall');
        },
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4).fill(200),
        }),
        putImageData: ({ data }: { data: Uint8ClampedArray }) => {
          this.steps.push([...data.subarray(0, 4)]);
          const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
          for (let at = 0; at < data.length; at += 4) {
            if ((data[at] ?? 0) <= (data[0] ?? 0) + 30) continue;
            const column = (at / 4) % this.width;
            const row = Math.floor(at / 4 / this.width);
            box.left = Math.min(box.left, column);
            box.right = Math.max(box.right, column + 1);
            box.top = Math.min(box.top, row);
            box.bottom = Math.max(box.bottom, row + 1);
          }
          lit.push(box);
        },
      };
    }
    transferToImageBitmap() {
      const frame = { frame: this.last, close: vi.fn() };
      frames.push(frame);
      laid.push(this.steps);
      this.steps = [];
      return frame;
    }
  }
  Object.defineProperty(window, 'OffscreenCanvas', { configurable: true, value: Layers });
  return { drawImage, decode, packed, laid, lit, colours, layers };
}

/**
 * The footage as painted: each paint's frame and, when the next frame is mixed
 * in, that frame and the strengths the two were laid at.
 */
function paints(layers: ReturnType<typeof fakeCanvas>['layers']) {
  const result: { frame: number; alpha: number; at: number; next?: number; mix?: number }[] = [];
  for (const layer of layers) {
    const last = result.at(-1);
    if (layer.mode === 'lighter' && last && last.next === undefined)
      Object.assign(last, { next: layer.frame, mix: layer.alpha });
    else result.push({ frame: layer.frame, alpha: layer.alpha, at: layer.at });
  }
  return result;
}

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
  it('keeps the page to the hand and a status line; the toolbar holds page, pause and help', () => {
    const grab = vi.fn();
    view.dispose();
    view = new HandView(document, { ...actions, grab });
    view.move(180, 230);
    expect(element('.effect').hidden).toBe(true);
    expect(shadow.querySelector('.cursor')).toBeNull();
    // Nothing on the page opens into a menu or card.
    for (const gone of ['.toggle', '.panel', '.receipt', '.close', '.snippet'])
      expect(shadow.querySelector(gone)).toBeNull();
    const labels = [...shadow.querySelectorAll('button')].map((button) => button.textContent);
    for (const moved of ['Grab selection', 'Save page', 'Settings', 'Pause everywhere'])
      expect(labels).not.toContain(moved);
    // The hand ends the bar, so a status growing beside it never moves it.
    expect(element('.bar').lastElementChild).toBe(element('.grab'));
    expect(element('.dock').dataset.state).toBe('idle');
    element('.grab').click();
    expect(grab).toHaveBeenCalledOnce();
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
    expect(element('.status').textContent).not.toContain('Saved');
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
    expect(element('.status').textContent).toBe('Still local.');
  });

  it('loads each hand once per page, plays its frames in order and never repeats a hand', async () => {
    const { drawImage, decode, packed, laid, layers } = fakeCanvas();
    const sprite = vi
      .fn<(hand: number) => Promise<Uint8Array<ArrayBuffer> | null>>()
      .mockRejectedValueOnce(new Error('Synthetic interrupted read'))
      .mockImplementation(async (hand) => packedHand(GRAVE_HANDS[hand]?.frames ?? 0));
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    view.setTarget(rectangle, 'A failed read is retried');
    await vi.advanceTimersByTimeAsync(0);
    view.setTarget(rectangle, 'Read while the user confirms');
    await vi.advanceTimersByTimeAsync(0);
    view.setTarget(rectangle, 'Never read twice');
    expect(sprite).toHaveBeenCalledTimes(2);
    const first = sprite.mock.calls[0]?.[0] ?? -1;
    expect(sprite.mock.calls[1]?.[0]).toBe(first);
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    // The plaster cracks before any footage shows.
    expect(drawImage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    // The frames on screen play in order; any mixed in is the one after.
    const shown = paints(layers);
    const drawn = shown.map(({ frame }) => frame);
    expect(drawn[0]).toBe(0);
    expect(drawn.length).toBeGreaterThan(5);
    expect(drawn.every((frame, index) => index === 0 || frame >= (drawn[index - 1] ?? 0))).toBe(
      true,
    );
    for (const { frame, next } of shown) if (next !== undefined) expect(next).toBe(frame + 1);
    // Only a handful of frames are ever held decoded at once.
    const open = frames.filter((frame) => !vi.mocked(frame.close).mock.calls.length);
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThanOrEqual(8);
    expect(decode.mock.calls.length).toBeGreaterThan(open.length);
    // Each packed frame is let go as soon as its layers are laid together.
    expect(packed.length).toBe(decode.mock.calls.length);
    for (const frame of packed) expect(frame.close).toHaveBeenCalledOnce();
    // On a white page the wall is the footage as filmed: no pixels are read back.
    expect(laid.length).toBe(packed.length);
    for (const steps of laid) expect(steps).toEqual(['wall', 'hand']);
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(element('.effect').hidden).toBe(true);
    for (const frame of frames) expect(frame.close).toHaveBeenCalledOnce();
    view.setTarget(rectangle, 'The next grab plays a different hand');
    await vi.advanceTimersByTimeAsync(0);
    const second = sprite.mock.lastCall?.[0];
    expect(second).not.toBe(first);
    expect(GRAVE_HANDS[second ?? -1]).toBeDefined();
  });

  it('tints the wall behind the hand to a dark page, never the hand', async () => {
    // Frames decode at the picked hand's own size, so its wall has a torn rim.
    const size = { width: 1, height: 1 };
    const { laid, lit, colours } = fakeCanvas(size);
    const sprite = vi.fn(async (hand: number) => {
      Object.assign(size, GRAVE_HANDS[hand]?.size);
      return packedHand(GRAVE_HANDS[hand]?.frames ?? 0);
    });
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    view.setTarget(rectangle, 'Words on a dark page', undefined, {
      style: { background: 'rgb(29, 33, 38)', color: 'rgb(217, 220, 214)', fontFamily: 'serif' },
    });
    await vi.advanceTimersByTimeAsync(0);
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    await vi.advanceTimersByTimeAsync(900);
    expect(laid.length).toBeGreaterThan(5);
    // The wall goes down first and is multiplied by the page's colour, its
    // alpha kept (its corner, far from the hole); the hand is laid over it as filmed.
    const tinted = [
      Math.round((200 * 29) / 255),
      Math.round((200 * 33) / 255),
      Math.round((200 * 38) / 255),
      200,
    ];
    for (const steps of laid) expect(steps).toEqual(['wall', tinted, 'hand']);
    // Around this hand's hole the torn rim is lifted, so it shows lighter than the
    // page: a ring centred on the hole, reaching out between 1.6 and 2.2 radii.
    const rimAround = (hand: number) => {
      const hole = GRAVE_HANDS[hand]?.hole;
      if (!hole) throw new Error('No hand was requested');
      expect(lit.length).toBe(laid.length);
      for (const { left, top, right, bottom } of lit.splice(0)) {
        expect((left + right) / 2).toBeCloseTo(hole.x, 0);
        expect((top + bottom) / 2).toBeCloseTo(hole.y, 0);
        expect((right - left) / 2 / hole.radius).toBeGreaterThan(1.6);
        expect((right - left) / 2 / hole.radius).toBeLessThan(2.2);
      }
    };
    rimAround(sprite.mock.lastCall?.[0] ?? -1);
    // Nothing drawn around it reads lighter than the page: cracks, dust and
    // debris are the page's own plaster. Only a faint lit edge may be lighter.
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    await vi.advanceTimersByTimeAsync(5_000);
    const lightness = (red: number, green: number, blue: number) =>
      0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const drawn = colours.map((colour) => {
      const [red = 0, green = 0, blue = 0, alpha = 1] = (colour.match(/[\d.]+/g) ?? []).map(Number);
      return { colour, alpha, lightness: lightness(red, green, blue) };
    });
    expect(drawn.length).toBeGreaterThan(20);
    expect(
      drawn.filter(({ alpha, lightness: value }) => alpha >= 0.3 && value > lightness(29, 33, 38)),
    ).toEqual([]);
    // The next grab plays a different hand, and its rim rings that hand's hole.
    laid.splice(0);
    lit.splice(0);
    view.setTarget(rectangle, 'More words on the dark page', undefined, {
      style: { background: 'rgb(29, 33, 38)', color: 'rgb(217, 220, 214)', fontFamily: 'serif' },
    });
    await vi.advanceTimersByTimeAsync(0);
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    await vi.advanceTimersByTimeAsync(900);
    expect(laid.length).toBeGreaterThan(5);
    expect(sprite.mock.calls[1]?.[0]).not.toBe(sprite.mock.calls[0]?.[0]);
    rimAround(sprite.mock.lastCall?.[0] ?? -1);
  });

  it('mixes each footage frame into the next as the display frame’s own time passes', async () => {
    const { layers } = fakeCanvas();
    const sprite = vi.fn(async (hand: number) => packedHand(GRAVE_HANDS[hand]?.frames ?? 0));
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    // A busy page gets to the callback late: the display frame began 10 ms earlier.
    const late = window.requestAnimationFrame;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      late((time) => callback(time - 10)),
    );
    view.setTarget(rectangle, 'Words that move on every display frame');
    await vi.advanceTimersByTimeAsync(0);
    const hand = GRAVE_HANDS[sprite.mock.calls[0]?.[0] ?? -1];
    if (!hand) throw new Error('No hand was requested');
    const step = grabEndFor(hand) / (PRE + hand.beats.fist + 1);
    const started = performance.now();
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    await vi.advanceTimersByTimeAsync(900);
    const shown = paints(layers);
    expect(shown.length).toBeGreaterThan(30);
    // Nearly every display frame mixes the next footage frame in, so the hand
    // moves on each of them rather than every second or third.
    expect(shown.filter(({ next }) => next !== undefined).length).toBeGreaterThan(
      shown.length * 0.9,
    );
    for (const { frame, alpha, at, next, mix } of shown) {
      const pose = (at - 10 - started) / step;
      expect(frame).toBe(Math.floor(pose) - PRE);
      if (next === undefined || mix === undefined) continue;
      // Laid at complementary strengths, set by how far that frame's time has come.
      expect(mix).toBeCloseTo(pose - Math.floor(pose), 6);
      expect(alpha + mix).toBeCloseTo(1, 9);
    }
  });

  it('decodes the first footage frames while the plaster cracks', async () => {
    const { decode, layers } = fakeCanvas();
    const sprite = vi.fn(async (hand: number) => packedHand(GRAVE_HANDS[hand]?.frames ?? 0));
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    view.setTarget(rectangle, 'Words the hand is ready for');
    await vi.advanceTimersByTimeAsync(0);
    const hand = GRAVE_HANDS[sprite.mock.calls[0]?.[0] ?? -1];
    if (!hand) throw new Error('No hand was requested');
    const step = grabEndFor(hand) / (PRE + hand.beats.fist + 1);
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    // Still cracking: no footage is on screen, but its first frames are decoding.
    await vi.advanceTimersByTimeAsync(PRE * step - 40);
    expect(layers).toHaveLength(0);
    const asked = decode.mock.calls.map(([blob]) => ((blob as Blob).size - 12) / 2);
    expect(asked).toContain(0);
    expect(asked.length).toBeLessThanOrEqual(8);
    await vi.advanceTimersByTimeAsync(80);
    expect(paints(layers)[0]?.frame).toBe(0);
  });

  it('keeps only the frames around a still fist decoded', async () => {
    fakeCanvas();
    const sprite = vi.fn(async (hand: number) => packedHand(GRAVE_HANDS[hand]?.frames ?? 0));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    try {
      view.dispose();
      view = new HandView(document, { ...actions, sprite });
      view.setTarget(rectangle, 'Words for a still grab');
      await vi.advanceTimersByTimeAsync(0);
      const hand = GRAVE_HANDS[sprite.mock.calls[0]?.[0] ?? -1];
      if (!hand) throw new Error('No hand was requested');
      // The grab starts cracking, asking for the first frames, then holds the fist at once.
      view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
      await vi.advanceTimersByTimeAsync(0);
      const open = frames.filter((frame) => !vi.mocked(frame.close).mock.calls.length);
      expect(open.length).toBeGreaterThan(0);
      expect(open.length).toBeLessThanOrEqual(8);
      const { fist } = hand.beats;
      for (const { frame } of open) {
        expect(frame).toBeGreaterThanOrEqual(fist - 1);
        expect(frame).toBeLessThanOrEqual(fist + 6);
      }
    } finally {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('covers where the page highlights a selection, not only the trimmed evidence', () => {
    view.setTarget(rectangle, 'Grab these words', [{ x: 10, y: 20, width: 128, height: 18 }], {
      highlight: [{ x: 10, y: 20, width: 136, height: 18 }],
    });
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    expect(element('.grave-patches div').style.width).toBe(`${136 + 4}px`);
  });

  it('holds the closed fist when the frames arrive after a reduced-motion grab', async () => {
    const { drawImage } = fakeCanvas();
    let deliver: (value: Uint8Array<ArrayBuffer>) => void = () => {};
    const sprite = vi.fn<(hand: number) => Promise<Uint8Array<ArrayBuffer> | null>>(
      () =>
        new Promise((done) => {
          deliver = done;
        }),
    );
    // jsdom has no matchMedia; this view prefers reduced motion.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    view.setTarget(rectangle, 'The first grab on a page');
    view.setState('saving', 'Taking hold…', 'Waiting for the vault.');
    expect(drawImage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    const hand = GRAVE_HANDS[sprite.mock.calls[0]?.[0] ?? -1];
    if (!hand) throw new Error('No hand was requested');
    deliver(packedHand(hand.frames));
    await vi.advanceTimersByTimeAsync(0);
    expect(drawImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ frame: hand.beats.fist }),
      0,
      0,
      hand.size.width,
      hand.size.height,
    );
    // A still pose runs no animation loop.
    const calls = drawImage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(drawImage.mock.calls.length).toBe(calls);
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('keeps undo accessible while collapsed and suppresses it during a different pending capture', () => {
    view.setState('saved', 'Buried, safely.', 'Saved to Obsidian.');
    view.setUndoAvailable(true);
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
    // The grab takes about two seconds, then the hand lingers a second before it fades.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(element('.effect').hidden).toBe(true);
    expect(element('.dock').dataset.state).toBe('saving');
    expect(element('.status').textContent).toBe('Queued locally.');
    expect(element('.detail').textContent).toBe('Waiting for the vault connection.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes the grab of a capture kept on this device, then buries it and heals the page', async () => {
    const sprite = vi.fn(async (_hand: number) => null);
    view.dispose();
    view = new HandView(document, { ...actions, sprite });
    view.setTarget(rectangle, 'Kept until the vault is connected.');
    view.setState('saving', 'Taking hold…', 'Preparing a durable local capture.');
    const hand = GRAVE_HANDS[sprite.mock.calls[0]?.[0] ?? -1];
    if (!hand) throw new Error('No hand was loaded');
    const grabEnd = grabEndFor(hand);
    await vi.advanceTimersByTimeAsync(40);
    view.setState('error', 'Kept on this device.', 'Connect a vault to bury it in Obsidian.', {
      kept: true,
    });
    // Still reaching for the words just before the fist closes on them.
    await vi.advanceTimersByTimeAsync(grabEnd - 140);
    expect(element('.effect').hidden).toBe(false);
    expect(element('.effect').dataset.phase).toBe('reach');
    // Kept is taken: the hand pulls the copy under and the page heals, while the
    // receipt still says the vault has not got it.
    await vi.advanceTimersByTimeAsync(300);
    expect(element('.effect').dataset.phase).toBe('bury');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(element('.effect').hidden).toBe(true);
    expect(element('.dock').dataset.state).toBe('error');
  });

  it('lets go at once when nothing was kept', async () => {
    view.setTarget(rectangle, 'Never captured.');
    view.setState('saving', 'Taking hold…', 'Preparing a durable local capture.');
    await vi.advanceTimersByTimeAsync(40);
    view.setState('error', 'The hand slipped.', 'The capture was refused.');
    await vi.advanceTimersByTimeAsync(0);
    expect(element('.effect').dataset.phase).toBe('release');
  });

  it('offers Connect vault beside the hand only when a vault fixes it, then lets the error go quiet', async () => {
    expect(shadow.querySelector('.connect')).toBeNull();
    const settings = vi.fn();
    view.dispose();
    view = new HandView(document, { ...actions, settings });
    const connect = element<HTMLButtonElement>('.connect');
    expect(connect.hidden).toBe(true);
    view.setState('error', 'Kept on this device.', 'Connect a vault to bury it in Obsidian.', {
      kept: true,
      settings: true,
    });
    expect(connect.hidden).toBe(false);
    expect(element('.status').textContent).toBe('Kept on this device.');
    expect(element('.detail').textContent).toBe('Connect a vault to bury it in Obsidian.');
    connect.click();
    expect(settings).toHaveBeenCalledOnce();
    // Readable for a while, then the hand alone keeps the warning colour.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(element('.dock').dataset.quiet).toBe('false');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(element('.dock').dataset.quiet).toBe('true');
    // Any later state takes the offer away again.
    view.setState('idle', 'Ready when you are.', 'Select text or click the hand.');
    expect(connect.hidden).toBe(true);
    expect(element('.dock').dataset.quiet).toBe('false');
    view.setState('error', 'The hand slipped.', 'Select some page text first.');
    expect(connect.hidden).toBe(true);
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
    const grab = vi.fn();
    view.dispose();
    view = new HandView(document, { ...actions, grab });
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
    const hand = element('.grab');
    view.dispose();
    expect(view.host.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    hand.click();
    expect(grab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(element('.effect').hidden).toBe(true);
  });

  it('keeps a related note behind its own small toggle and rejects executable links', () => {
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
    expect(element('.ghost-toggle').hidden).toBe(true);
    view.setGhost(ghost);
    expect(element('.ghost').hidden).toBe(true);
    expect(element('.ghost-toggle').hidden).toBe(false);
    element('.ghost-toggle').click();
    expect(element('.ghost-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(element('.ghost').hidden).toBe(false);
    expect(element('.ghost a').textContent).toBe('<b>Source title</b>');
    expect(shadow.querySelector('img')).toBeNull();
    view.setGhost({ ...ghost, sourceUrl: 'javascript:alert(1)' });
    expect(element('.ghost').hidden).toBe(true);
    expect(element('.ghost-toggle').hidden).toBe(true);
    expect(element('.ghost a').hasAttribute('href')).toBe(false);
  });
});
