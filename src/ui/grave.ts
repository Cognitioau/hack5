/**
 * Decorative grave-hand choreography. The page cracks like plaster, a hand
 * punches through it, slaps down on the target, snatches a paper copy of the
 * words and drags it back through the hole. The wall then mends: footage of it
 * bursting open into the same hole plays backwards, so the plaster flies back
 * in, the cracks close and the page is whole again.
 * It never decides persistence: the view starts, buries or releases it only in
 * response to real capture state, and the source page DOM is never touched.
 *
 * The hand and the heal are generated footage matted onto a transparent layer
 * (scripts/hand), one of several takes picked per grab, with the heal matted
 * onto each. Its frames arrive as bytes and are decoded a few at a time around
 * the one on screen, so the page's CSP never sees a URL and only a handful of
 * frames are ever held decoded. The cracks, the torn hole, the debris and dust
 * of the break-in and the paper copy are drawn here around it.
 */

import { GRAVE_FPS, GRAVE_HANDS, type GraveHand } from './grave-sprite';

export type GraveKind = 'text' | 'page';
export interface GraveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScrapStyle {
  fontFamily: string;
  color: string;
  background: string;
  /** Computed size of the reading text, in px; the hand is sized from it. */
  fontSize?: number;
}
export interface GraveScene {
  kind: GraveKind;
  /** The highlighted passage; a page grab uses the viewport. */
  source: GraveRect;
  /** The passage's line boxes, covered once the hand has taken the words. */
  rectangles?: readonly GraveRect[];
  viewport: { width: number; height: number };
  /** Snippet copy for text, or the page title. Always rendered as text. */
  text: string;
  /** Page host for a page grab. */
  detail?: string;
  style?: ScrapStyle;
}

/** Steps (footage frames) of cracks spreading before the wall gives way. */
const PRE = 5;
/** Steps for the hole to tear open around the punch. */
const OPEN = 3;
/** A release rewinds the grab at least twice as fast, and never takes longer than this. */
const RELEASE_MS = 450;
const STEP_MS = 1_000 / GRAVE_FPS;
/** The hands were tuned at 260 px across the footage frame over 17 px text. */
const DISPLAY_PER_FONT_PX = 260 / 17;
/** Radius in px of the hole's dark core when the debris and dust were tuned; they scale with it. */
const TUNED_HOLE = 34;
/** The page card a page grab peels the viewport into. */
const CARD = { width: 168, height: 96 };
/** Durations the view schedules its own state changes against. */
export const GRAVE_DURATION = { fade: 400 } as const;

interface Point {
  x: number;
  y: number;
}
interface Chunk {
  angle: number;
  speed: number;
  size: number;
  spin: number;
  shape: [number, number][];
  delay: number;
  /** How fast it grows as it flies at the viewer. */
  toward: number;
  tone: number;
}
interface Puff {
  angle: number;
  distance: number;
  size: number;
  delay: number;
}
export interface GraveLayout {
  kind: GraveKind;
  /** Index into GRAVE_HANDS. */
  index: number;
  hand: GraveHand;
  /** CSS px per footage frame px. */
  scale: number;
  /** Top-left of the footage layer. */
  place: Point;
  hole: Point & { r: number };
  /** Where the words are taken from: the passage's centre, or the page card's resting place. */
  word: Point;
  /** Page-coloured patches over the taken words. */
  patches: GraveRect[];
  /** The viewport a page grab's sheet peels off. */
  sheet: GraveRect;
  dark: boolean;
  /** Crack polylines as [x, y, width] points, spreading from the hole. */
  cracks: [number, number, number][][];
  crackBox: GraveRect;
  /** Effect sizes relative to the size the hands were tuned at. */
  unit: number;
  chunks: Chunk[];
  puffs: Puff[];
  /** The torn edge: a ragged radius profile the hole tears open along. */
  rim: number[];
}
export interface GravePose {
  /** Footage steps since the cracks began; fractional between frames. */
  step: number;
  /** Debris and dust only fly while the grab plays forwards. */
  forward: boolean;
  opacity: number;
}
export type GraveState =
  | { phase: 'grab'; t: number }
  | { phase: 'bury' | 'release' | 'fade'; u: number; from: GravePose };

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;
const progress = (t: number, start: number, end: number): number =>
  clamp((t - start) / (end - start), 0, 1);
const outCubic = (x: number): number => 1 - (1 - x) ** 3;

/** A fixed seed keeps every burst identical, so reviews and tests see the same frames. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A random hand, never the one that played last, so consecutive grabs differ. */
export function pickHand(previous?: number, random: () => number = Math.random): number {
  const count = GRAVE_HANDS.length;
  const draw = (range: number) => Math.min(range - 1, Math.floor(random() * range));
  if (previous === undefined || count < 2) return draw(count);
  const pick = draw(count - 1);
  return pick >= previous ? pick + 1 : pick;
}

/** Splits a packaged hand into its WebP frames, which are stored back to back. */
export function splitFrames(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length || tag(offset) !== 'RIFF' || tag(offset + 8) !== 'WEBP')
      throw new Error('The hand footage is not a run of WebP frames.');
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) throw new Error('The hand footage is truncated.');
    frames.push(bytes.subarray(offset, end));
    offset = end;
  }
  return frames;
}

const fistStep = (hand: GraveHand): number => PRE + hand.beats.fist;
const lastStep = (hand: GraveHand): number => PRE + hand.frames - 1 + hand.heal;

/** Milliseconds from the start of a grab until the fist has closed on the words. */
export function grabEndFor(hand: GraveHand): number {
  return (fistStep(hand) + 1) * STEP_MS;
}

export function graveLayout(scene: GraveScene, index = 0): GraveLayout {
  const hand = GRAVE_HANDS[index] ?? (GRAVE_HANDS[0] as GraveHand);
  const width = Math.max(1, scene.viewport.width);
  const height = Math.max(1, scene.viewport.height);
  const page = scene.kind === 'page';
  const fist = hand.grip[hand.beats.fist] ?? { x: hand.hole.x, y: hand.hole.y / 2 };
  const reach = hand.hole.radius * 1.5; // the crater's outer edge, in frame px
  const below = hand.hole.y + reach - fist.y; // from the fist down to the crater's edge
  const fontSize = clamp(scene.style?.fontSize ?? 16, 9, 32);
  const display = Math.min(clamp(fontSize * DISPLAY_PER_FONT_PX, 180, 320), width * 0.75);
  let scale = display / hand.source;
  const source = scene.source;
  // The fist closes on the part of the passage that is on screen.
  const word = page
    ? { x: width / 2, y: Math.max(height / 2, height - 48 - below * scale) }
    : {
        x: (clamp(source.x, 0, width) + clamp(source.x + source.width, 0, width)) / 2,
        y: (clamp(source.y, 0, height) + clamp(source.y + source.height, 0, height)) / 2,
      };
  // The hole opens below the words: near the foot of the viewport the hand
  // shrinks to fit, and if it still cannot, it reaches up from lower down.
  const room = height - 8 - word.y;
  if (below * scale > room) scale = Math.max(scale * 0.7, room / below);
  const place = { x: word.x - fist.x * scale, y: word.y - fist.y * scale };
  const floor = place.y + (hand.hole.y + reach) * scale;
  if (floor > height - 8) place.y -= floor - (height - 8);
  const side = reach * scale + 8;
  const holeX = place.x + hand.hole.x * scale;
  place.x += clamp(holeX, side, Math.max(side, width - side)) - holeX;
  const hole = {
    x: place.x + hand.hole.x * scale,
    y: place.y + hand.hole.y * scale,
    r: hand.hole.radius * scale,
  };
  const unit = hole.r / TUNED_HOLE;

  const random = seeded(7);
  const rim = Array.from({ length: 48 }, () => 0.82 + random() * 0.36);
  // Plaster cracks running out from where the wall will break.
  const cracks: [number, number, number][][] = [];
  const grow = (
    x: number,
    y: number,
    direction: number,
    length: number,
    thickness: number,
    depth: number,
  ): void => {
    const points: [number, number, number][] = [[x, y, thickness]];
    for (let along = 0; along < length; along += 4 * unit) {
      direction += (random() - 0.5) * 0.8;
      x += Math.cos(direction) * 4 * unit;
      y += Math.sin(direction) * 4 * unit;
      points.push([x, y, thickness * (1 - along / length)]);
      if (depth < 2 && random() < 0.1)
        grow(
          x,
          y,
          direction + (random() < 0.5 ? 0.9 : -0.9),
          length * 0.45,
          thickness * 0.6,
          depth + 1,
        );
    }
    cracks.push(points);
  };
  for (let index = 0; index < 9; index++) {
    const angle = (index / 9) * Math.PI * 2 + random() * 0.5;
    grow(
      hole.x + Math.cos(angle) * hole.r * 0.5,
      hole.y + Math.sin(angle) * hole.r * 0.5,
      angle,
      hole.r * 0.9 + random() * hole.r * 1.6,
      1.4 + random() * 1.1,
      0,
    );
  }
  const xs = cracks.flat().map(([x]) => x);
  const ys = cracks.flat().map(([, y]) => y);
  const crackBox = {
    x: Math.floor(Math.min(...xs) - 4),
    y: Math.floor(Math.min(...ys) - 4),
    width: Math.ceil(Math.max(...xs) - Math.min(...xs) + 8),
    height: Math.ceil(Math.max(...ys) - Math.min(...ys) + 8),
  };
  // Plaster thrown out at the viewer, then falling down the wall.
  const chunks = Array.from({ length: 34 }, (_, index): Chunk => {
    const angle = random() * Math.PI * 2;
    const speed = 120 + random() * 320;
    const sides = 4 + Math.floor(random() * 3);
    const shape = Array.from({ length: sides }, (_, corner): [number, number] => {
      const theta = (corner / sides) * Math.PI * 2;
      const radius = 0.6 + random() * 0.5;
      return [Math.cos(theta) * radius, Math.sin(theta) * radius];
    });
    const big = index < 7;
    return {
      angle,
      speed: speed * (big ? 0.8 : 1.3) * unit,
      size: (big ? 3 + random() * 3.5 : 0.8 + random() * 1.6) * unit,
      spin: (random() - 0.5) * 14,
      shape,
      delay: random() * 0.06,
      toward: 0.6 + random() * 1.4,
      tone: 165 + random() * 60,
    };
  });
  const puffs = Array.from(
    { length: 10 },
    (): Puff => ({
      angle: random() * Math.PI * 2,
      distance: (20 + random() * 40) * unit,
      size: (18 + random() * 26) * unit,
      delay: random() * 0.08,
    }),
  );

  const lines = page ? [] : scene.rectangles?.length ? scene.rectangles : [source];
  const patches = lines
    .slice(0, 128)
    .filter((area) => [area.x, area.y, area.width, area.height].every(Number.isFinite))
    .map((area) => ({
      x: area.x - 2,
      y: area.y - 1,
      width: area.width + 4,
      height: area.height + 2,
    }));
  const rgb = parseColor(scene.style?.background) ?? [255, 255, 255];
  return {
    kind: scene.kind,
    index: GRAVE_HANDS[index] ? index : 0,
    hand,
    scale,
    place,
    hole,
    word,
    patches,
    sheet: { x: 0, y: 0, width, height },
    dark: (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.4,
    cracks,
    crackBox,
    unit,
    chunks,
    puffs,
    rim,
  };
}

export function poseAt(layout: GraveLayout, state: GraveState): GravePose {
  const { hand } = layout;
  if (state.phase === 'grab')
    return {
      step: Math.min(Math.max(0, state.t) / STEP_MS, fistStep(hand)),
      forward: true,
      opacity: 1,
    };
  const u = Math.max(0, state.u);
  const { from } = state;
  if (state.phase === 'bury')
    return { ...from, step: Math.min(from.step + u / STEP_MS, lastStep(hand)), forward: true };
  if (state.phase === 'release') {
    const duration = releaseDuration(from);
    return {
      ...from,
      step: duration ? from.step * (1 - Math.min(1, u / duration)) : 0,
      forward: false,
    };
  }
  return { ...from, opacity: from.opacity * (1 - progress(u, 0, GRAVE_DURATION.fade)) };
}

/** Milliseconds a bury takes from a pose: the yank back through the hole, then the heal. */
export function buryDuration(layout: GraveLayout, from: GravePose): number {
  return Math.max(0, lastStep(layout.hand) - from.step) * STEP_MS;
}

/** Milliseconds a release takes from a pose: the grab rewound to the first crack. */
export function releaseDuration(from: GravePose): number {
  return Math.min(RELEASE_MS, (from.step * STEP_MS) / 2);
}

/**
 * The footage frame shown at a step, or null before the wall gives way. Once
 * the hand is gone the heal's frames, packed after the take's, play on.
 */
export function footageFrame(layout: GraveLayout, step: number): number | null {
  const frame = Math.floor(step) - PRE;
  return frame < 0 ? null : Math.min(frame, layout.hand.frames + layout.hand.heal - 1);
}

/** How far the heal has played: 0 at its first frame, 1 once the wall is whole. */
export function healAt(layout: GraveLayout, step: number): number {
  return progress(step - PRE - layout.hand.frames, 0, layout.hand.heal - 1);
}

export interface ScrapPose {
  visible: boolean;
  x: number;
  y: number;
  rotation: number;
  sx: number;
  sy: number;
  skew: number;
}

/**
 * The paper copy: for text it appears where the fingers close on the words and
 * rides in the fist, crumpling; a page's sheet first peels off the viewport
 * into a card for the hand to slap down on.
 */
export function scrapAt(layout: GraveLayout, step: number): ScrapPose {
  const { hand, word, scale } = layout;
  const frame = Math.floor(step) - PRE;
  const resting = { visible: true, ...word, rotation: 0, sx: 1, sy: 1, skew: 0 };
  if (frame < hand.beats.take) {
    if (layout.kind === 'text') return { ...resting, visible: false };
    const peel = outCubic(progress(step, 0, PRE + hand.beats.slam));
    const { sheet } = layout;
    return {
      ...resting,
      x: lerp(sheet.x + sheet.width / 2, word.x, peel),
      y: lerp(sheet.y + sheet.height / 2, word.y, peel),
      rotation: -4 * peel,
      sx: lerp(sheet.width / CARD.width, 1, peel),
      sy: lerp(sheet.height / CARD.height, 1, peel),
    };
  }
  const grip = frame < hand.frames ? hand.grip[frame] : null;
  if (!grip) return { ...resting, visible: false };
  const k = Math.min(1, (step - PRE - hand.beats.take) / 4);
  const crumple = 1 - 0.42 * k;
  return {
    visible: true,
    // A crumpled end of the copy shows past the thumb.
    x: lerp(word.x, layout.place.x + grip.x * scale, k) - 21 * scale * k,
    y: lerp(word.y, layout.place.y + grip.y * scale, k),
    rotation: (layout.kind === 'page' ? -4 : 0) - 14 * k,
    sx: crumple,
    sy: crumple * (1 - 0.25 * k),
    skew: 8 * k,
  };
}

function parseColor(value: string | undefined): [number, number, number] | null {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/u.exec(
    value ?? '',
  );
  if (!match) return null;
  const alpha =
    match[4] === undefined ? 1 : Number.parseFloat(match[4]) / (match[4].endsWith('%') ? 100 : 1);
  if (alpha < 0.5) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

type Decode = (frame: Blob) => Promise<ImageBitmap>;

/** One hand's frames: kept as compressed bytes, decoded only around the frame on screen. */
class Footage {
  private readonly decoded = new Map<number, ImageBitmap>();
  private readonly pending = new Set<number>();
  private generation = 0;

  constructor(
    readonly frames: readonly Blob[],
    private readonly decode: Decode,
    private readonly ready: () => void,
  ) {}

  /** Decodes the frames just ahead along the direction of play and lets the rest go. */
  want(index: number, forward: boolean): void {
    const low = forward ? index - 1 : index - 6;
    const high = forward ? index + 6 : index + 1;
    for (const [frame, bitmap] of this.decoded)
      if (frame < low || frame > high) {
        bitmap.close();
        this.decoded.delete(frame);
      }
    const generation = this.generation;
    for (let frame = Math.max(0, low); frame <= Math.min(high, this.frames.length - 1); frame++) {
      const blob = this.frames[frame];
      if (!blob || this.decoded.has(frame) || this.pending.has(frame)) continue;
      this.pending.add(frame);
      this.decode(blob).then(
        (bitmap) => {
          this.pending.delete(frame);
          if (generation !== this.generation) bitmap.close();
          else {
            this.decoded.set(frame, bitmap);
            this.ready();
          }
        },
        () => {
          this.pending.delete(frame);
        },
      );
    }
  }

  /** The decoded frame at `index`, or failing that the nearest one already played. */
  get(index: number, forward: boolean): ImageBitmap | null {
    for (let back = 0; back < 4; back++) {
      const bitmap = this.decoded.get(forward ? index - back : index + back);
      if (bitmap) return bitmap;
    }
    return null;
  }

  release(): void {
    this.generation += 1;
    for (const bitmap of this.decoded.values()) bitmap.close();
    this.decoded.clear();
  }
}

const dustTone = (layout: GraveLayout): string => (layout.dark ? '200,196,186' : '214,208,196');

/** A soft puff of plaster dust. */
function dustCloud(
  context: CanvasRenderingContext2D,
  tone: string,
  x: number,
  y: number,
  size: number,
  alpha: number,
): void {
  const gradient = context.createRadialGradient(x, y, 0, x, y, size);
  gradient.addColorStop(0, `rgba(${tone},${alpha})`);
  gradient.addColorStop(1, `rgba(${tone},0)`);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, size, 0, Math.PI * 2);
  context.fill();
}

export class GraveEffect {
  readonly element: HTMLDivElement;
  private readonly cracks: HTMLCanvasElement;
  private readonly patches: HTMLDivElement;
  private readonly scrap: HTMLDivElement;
  private readonly sprite: HTMLCanvasElement;
  private readonly fx: HTMLCanvasElement;
  private readonly footage = new Map<number, Footage>();
  private layout: GraveLayout | null = null;
  private state: GraveState | null = null;
  private painted: GravePose | null = null;
  private startedAt = 0;
  /** A held still keeps its pose; the clock no longer advances it. */
  private held = false;
  private frame: number | undefined;

  constructor(
    private readonly document: Document,
    private readonly decode: Decode = (frame) => {
      const view = document.defaultView;
      if (!view?.createImageBitmap) return Promise.reject(new Error('No image decoder'));
      return view.createImageBitmap(frame);
    },
  ) {
    const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string) => {
      const element = document.createElement(tag);
      element.className = className;
      return element;
    };
    this.element = node('div', 'grave');
    this.element.setAttribute('aria-hidden', 'true');
    this.cracks = node('canvas', 'grave-cracks');
    this.patches = node('div', 'grave-patches');
    // The copy sits under the footage, so the fingers close over it.
    this.scrap = node('div', 'grave-scrap');
    this.sprite = node('canvas', 'grave-hand');
    this.fx = node('canvas', 'grave-fx');
    this.element.append(this.cracks, this.patches, this.scrap, this.sprite, this.fx);
    this.element.hidden = true;
  }

  /** Supply a hand's packaged frames. Until they arrive its grave opens without a hand. */
  useFootage(index: number, bytes: Uint8Array<ArrayBuffer>): void {
    let frames: Blob[];
    try {
      frames = splitFrames(bytes).map((frame) => new Blob([frame], { type: 'image/webp' }));
    } catch {
      return;
    }
    this.footage.get(index)?.release();
    this.footage.set(
      index,
      new Footage(frames, this.decode, () => {
        this.painted = null;
        if (this.held || this.frame === undefined) this.render();
      }),
    );
    if (this.layout?.index === index) {
      this.painted = null;
      this.render();
    }
  }

  /** Begin a new grab with one of the hands. Any previous scene is discarded. */
  start(scene: GraveScene, hand = 0): void {
    this.releaseFrames();
    const layout = graveLayout(scene, hand);
    this.layout = layout;
    const style = this.element.style;
    style.setProperty('--paper', scene.style?.background || '#ffffff');
    style.setProperty('--paper-ink', scene.style?.color || '#28301f');
    if (scene.style?.fontFamily) style.setProperty('--paper-font', scene.style.fontFamily);
    else style.removeProperty('--paper-font');
    style.setProperty('--paper-size', `${clamp(scene.style?.fontSize ?? 16, 9, 32)}px`);
    this.fillPatches(layout);
    this.fillScrap(scene);
    const dpr = this.dpr();
    this.size(this.cracks, layout.crackBox, dpr);
    const { width, height } = layout.hand.size;
    this.size(
      this.sprite,
      { ...layout.place, width: width * layout.scale, height: height * layout.scale },
      dpr,
    );
    this.state = { phase: 'grab', t: 0 };
    this.painted = null;
    this.startedAt = this.now();
    this.held = false;
    this.element.hidden = false;
    this.render();
    this.loop();
  }

  /** Pull the copy under and heal the hole; returns how long that takes. */
  bury(): number {
    const from = this.transition('bury');
    return from && this.layout ? buryDuration(this.layout, from) : 0;
  }

  /** Rewind the grab, putting the words back; returns how long that takes. */
  release(): number {
    const from = this.transition('release');
    return from ? releaseDuration(from) : 0;
  }

  fade(): void {
    this.transition('fade');
  }

  /** Render the closed fist as a still pose without running the loop (reduced motion). */
  hold(): void {
    if (!this.layout) return;
    this.stop();
    this.state = { phase: 'grab', t: this.grabEnd };
    this.held = true;
    this.render();
  }

  hide(): void {
    this.stop();
    this.releaseFrames();
    this.layout = null;
    this.state = null;
    this.painted = null;
    this.held = false;
    this.element.hidden = true;
    this.patches.replaceChildren();
    this.scrap.replaceChildren();
    // Full-size canvases are only held while a grab is on screen.
    for (const canvas of [this.cracks, this.sprite, this.fx]) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  get active(): boolean {
    return this.layout !== null;
  }

  /** Milliseconds from start until the copy is firmly held. */
  get grabEnd(): number {
    return this.layout ? grabEndFor(this.layout.hand) : 0;
  }

  private now(): number {
    return this.document.defaultView?.performance.now() ?? 0;
  }

  private dpr(): number {
    return clamp(this.document.defaultView?.devicePixelRatio ?? 1, 1, 2);
  }

  private releaseFrames(): void {
    if (this.layout) this.footage.get(this.layout.index)?.release();
  }

  private current(): GraveState | null {
    if (!this.state || this.held) return this.state;
    const elapsed = this.now() - this.startedAt;
    return this.state.phase === 'grab'
      ? { phase: 'grab', t: elapsed }
      : { ...this.state, u: elapsed };
  }

  private transition(phase: 'bury' | 'release' | 'fade'): GravePose | null {
    const current = this.current();
    if (!this.layout || !current) return null;
    const from = poseAt(this.layout, current);
    this.state = { phase, u: 0, from };
    this.startedAt = this.now();
    this.held = false;
    this.render();
    this.loop();
    return from;
  }

  private loop(): void {
    const view = this.document.defaultView;
    if (!view || this.frame !== undefined || typeof view.requestAnimationFrame !== 'function')
      return;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = undefined;
      if (!this.layout) return;
      this.render();
      this.loop();
    });
  }

  private stop(): void {
    if (this.frame !== undefined) this.document.defaultView?.cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  private render(): void {
    const state = this.current();
    if (!this.layout || !state) return;
    const pose = poseAt(this.layout, state);
    const last = this.painted;
    if (
      last &&
      last.step === pose.step &&
      last.forward === pose.forward &&
      last.opacity === pose.opacity
    )
      return;
    this.painted = pose;
    this.paint(this.layout, pose);
  }

  /** Sizes a canvas to a page box; its context then draws in page px. */
  private size(canvas: HTMLCanvasElement, box: GraveRect, dpr: number): void {
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    canvas.style.transform = `translate(${box.x}px, ${box.y}px)`;
  }

  private fillPatches(layout: GraveLayout): void {
    this.patches.replaceChildren(
      ...layout.patches.map((area) => {
        const patch = this.document.createElement('div');
        patch.style.left = `${area.x}px`;
        patch.style.top = `${area.y}px`;
        patch.style.width = `${area.width}px`;
        patch.style.height = `${area.height}px`;
        return patch;
      }),
    );
  }

  private fillScrap(scene: GraveScene): void {
    const slip = this.document.createElement('div');
    slip.className = `slip ${scene.kind}`;
    const words = this.document.createElement('p');
    words.className = 'grabbed';
    words.textContent = scene.text.slice(0, 220) || 'Source reference';
    slip.append(words);
    if (scene.kind === 'page') {
      const detail = this.document.createElement('p');
      detail.className = 'host';
      detail.textContent = (scene.detail ?? '').slice(0, 80);
      slip.append(detail);
      for (let line = 0; line < 3; line++) slip.append(this.document.createElement('i'));
    }
    this.scrap.replaceChildren(slip);
  }

  private paint(layout: GraveLayout, pose: GravePose): void {
    this.element.style.opacity = pose.opacity.toFixed(3);
    this.drawCracks(layout, pose.step);
    this.drawFootage(layout, pose);
    this.drawFx(layout, pose);
    this.placeWords(layout, pose.step);
  }

  private drawCracks(layout: GraveLayout, step: number): void {
    const context = this.cracks.getContext('2d');
    if (!context) return;
    const dpr = this.dpr();
    const box = layout.crackBox;
    context.setTransform(dpr, 0, 0, dpr, -box.x * dpr, -box.y * dpr);
    context.clearRect(box.x, box.y, box.width, box.height);
    // They run out from the hole, then draw back in and fade as the plaster flies
    // home, gone before the footage's own cracks close.
    const heal = healAt(layout, step);
    const spread = Math.min(1, (step + 1) / (PRE + 1)) * (1 - 0.85 * progress(heal, 0.3, 0.8));
    const fade = 1 - progress(heal, 0.5, 0.8);
    if (fade <= 0) return;
    context.lineCap = 'round';
    for (const points of layout.cracks) {
      const count = Math.max(1, Math.floor(points.length * spread));
      for (let index = 1; index <= count && index < points.length; index++) {
        const [x0, y0] = points[index - 1] as [number, number, number];
        const [x1, y1, thickness] = points[index] as [number, number, number];
        // A lit lower lip, then the dark split itself.
        context.globalAlpha = fade;
        context.strokeStyle = layout.dark ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.7)';
        context.lineWidth = thickness * 0.7 + 0.4;
        context.beginPath();
        context.moveTo(x0 + 0.7, y0 + 0.8);
        context.lineTo(x1 + 0.7, y1 + 0.8);
        context.stroke();
        context.globalAlpha = fade * 0.7;
        context.strokeStyle = 'rgb(40,36,32)';
        context.lineWidth = Math.max(0.35, thickness);
        context.beginPath();
        context.moveTo(x0, y0);
        context.lineTo(x1, y1);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
  }

  /** A ragged circle around the hole, in frame px. */
  private ragged(context: CanvasRenderingContext2D, hand: GraveHand, radius: number): void {
    const rim = this.layout?.rim ?? [1];
    context.beginPath();
    for (const [index, k] of rim.entries()) {
      const angle = (index / rim.length) * Math.PI * 2;
      const x = hand.hole.x + Math.cos(angle) * radius * k;
      const y = hand.hole.y + Math.sin(angle) * radius * k;
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    }
    context.closePath();
  }

  private drawFootage(layout: GraveLayout, pose: GravePose): void {
    const context = this.sprite.getContext('2d');
    if (!context) return;
    const { hand } = layout;
    const { width, height } = hand.size;
    const frame = footageFrame(layout, pose.step);
    const footage = this.footage.get(layout.index);
    const scale = this.dpr() * layout.scale;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    // Nothing shows before the wall gives way.
    if (frame === null) {
      context.clearRect(0, 0, width, height);
      return;
    }
    footage?.want(frame, pose.forward);
    const image = footage?.get(frame, pose.forward);
    // A frame still decoding keeps the last one drawn rather than blinking out.
    if (!image) return;
    context.clearRect(0, 0, width, height);
    const reach = hand.hole.radius * 1.5; // the crater's outer edge
    const opened = Math.floor(pose.step) - PRE;
    if (opened < OPEN) {
      // The wall tears open: only what is inside the growing tear shows.
      context.save();
      this.ragged(context, hand, reach * (0.35 + (0.65 * (opened + 1)) / OPEN));
      context.clip();
      context.drawImage(image, 0, 0, width, height);
      context.restore();
      return;
    }
    // The heal's last cracks fade into the page, so hiding the layer leaves nothing behind.
    context.globalAlpha = 1 - progress(healAt(layout, pose.step), 0.85, 1);
    context.drawImage(image, 0, 0, width, height);
    context.globalAlpha = 1;
  }

  private drawFx(layout: GraveLayout, pose: GravePose): void {
    const { hand, hole, unit } = layout;
    const burst = (pose.step - PRE + 0.5) / GRAVE_FPS; // seconds since the wall gave way
    const slap = (pose.step - PRE - hand.beats.slam + 0.5) / GRAVE_FPS;
    const flying = pose.forward && ((burst >= 0 && burst < 0.9) || (slap > 0 && slap < 0.45));
    if (!flying) {
      // The full-viewport layer is only held while something is in the air.
      if (this.fx.width) {
        this.fx.width = 0;
        this.fx.height = 0;
      }
      return;
    }
    const view = { x: 0, y: 0, width: layout.sheet.width, height: layout.sheet.height };
    if (!this.fx.width) this.size(this.fx, view, 1);
    const context = this.fx.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, view.width, view.height);
    const tone = dustTone(layout);
    const dust = (x: number, y: number, size: number, alpha: number) =>
      dustCloud(context, tone, x, y, size, alpha);
    if (burst >= 0 && burst < 0.9) {
      for (const puff of layout.puffs) {
        const t = burst - puff.delay;
        if (t < 0) continue;
        const k = Math.min(1, t / 0.7);
        dust(
          hole.x + Math.cos(puff.angle) * puff.distance * (0.4 + k),
          hole.y + Math.sin(puff.angle) * puff.distance * (0.4 + k) + 30 * unit * k * k,
          puff.size * (0.6 + k * 1.4),
          0.42 * (1 - k),
        );
      }
      for (const chunk of layout.chunks) {
        const t = burst - chunk.delay;
        if (t < 0 || t > 0.8) continue;
        const grow = 1 + chunk.toward * Math.min(t, 0.35);
        const at = (u: number): [number, number] => [
          hole.x + Math.cos(chunk.angle) * (hole.r + chunk.speed * u),
          hole.y + Math.sin(chunk.angle) * (hole.r + chunk.speed * u) + 750 * unit * u * u,
        ];
        const [x, y] = at(t);
        if (t < 0.25) {
          // A short streak behind it while it is fast.
          const [px, py] = at(Math.max(0, t - 0.03));
          context.strokeStyle = `rgba(${chunk.tone},${chunk.tone - 4},${chunk.tone - 12},${0.35 * (1 - t / 0.25)})`;
          context.lineWidth = chunk.size * grow * 0.9;
          context.lineCap = 'round';
          context.beginPath();
          context.moveTo(px, py);
          context.lineTo(x, y);
          context.stroke();
        }
        context.save();
        context.translate(x, y);
        context.rotate(chunk.spin * t);
        context.scale(chunk.size * grow, chunk.size * grow);
        context.globalAlpha = clamp((0.8 - t) / 0.25, 0, 1);
        context.beginPath();
        for (const [index, [px, py]] of chunk.shape.entries()) {
          if (index) context.lineTo(px, py);
          else context.moveTo(px, py);
        }
        context.closePath();
        const shade = context.createLinearGradient(-1, -1, 1, 1);
        shade.addColorStop(0, `rgb(${chunk.tone + 30},${chunk.tone + 27},${chunk.tone + 20})`);
        shade.addColorStop(1, `rgb(${chunk.tone - 50},${chunk.tone - 54},${chunk.tone - 60})`);
        context.fillStyle = shade;
        context.fill();
        context.restore();
      }
    }
    // The slap kicks dust out from under the palm.
    const palm = hand.grip[hand.beats.slam];
    if (palm && slap > 0 && slap < 0.45) {
      const x = layout.place.x + palm.x * layout.scale;
      const y = layout.place.y + palm.y * layout.scale;
      const k = slap / 0.45;
      for (let index = 0; index < 8; index++) {
        const angle = (index / 8) * Math.PI * 2;
        dust(
          x + Math.cos(angle) * (50 + 40 * k) * unit,
          y + 40 * unit + Math.sin(angle) * (40 + 30 * k) * unit,
          (10 + 16 * k) * unit,
          0.32 * (1 - k),
        );
      }
    }
  }

  private placeWords(layout: GraveLayout, step: number): void {
    const frame = Math.floor(step) - PRE;
    const taken = layout.kind === 'text' && frame >= layout.hand.beats.take;
    this.patches.hidden = !taken;
    // The words come back as the wall closes over the hole.
    if (taken) this.patches.style.opacity = (1 - progress(healAt(layout, step), 0.7, 1)).toFixed(3);
    const scrap = scrapAt(layout, step);
    this.scrap.hidden = !scrap.visible;
    if (!scrap.visible) return;
    const fixed = (value: number) => value.toFixed(2);
    this.scrap.style.transform = `translate(${fixed(scrap.x)}px, ${fixed(scrap.y)}px) rotate(${fixed(scrap.rotation)}deg) scale(${fixed(scrap.sx)}, ${fixed(scrap.sy)}) skewX(${fixed(scrap.skew)}deg) translate(-50%, -50%)`;
    this.scrap.style.opacity = layout.kind === 'page' ? fixed(progress(step, 0, 3)) : '1';
  }
}
