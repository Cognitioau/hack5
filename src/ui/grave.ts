/**
 * Decorative grave-hand choreography. The page tears open below the target, a
 * hand bursts up, snatches a paper copy of the words and drags it under.
 * It never decides persistence: the view starts, buries or releases it only in
 * response to real capture state, and the source page DOM is never touched.
 */

const SVG = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';

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
}
export interface GraveScene {
  kind: GraveKind;
  /** The highlighted passage; a page grab uses the viewport. */
  source: GraveRect;
  viewport: { width: number; height: number };
  /** Snippet copy for text, or the page title. Always rendered as text. */
  text: string;
  /** Page host for a page grab. */
  detail?: string;
  style?: ScrapStyle;
}

interface Timing {
  riseStart: number;
  riseEnd: number;
  flyStart: number;
  swap: number;
  curlStart: number;
  curlEnd: number;
  grabEnd: number;
}
const TEXT_TIMING: Timing = {
  riseStart: 150,
  riseEnd: 480,
  flyStart: 330,
  swap: 560,
  curlStart: 530,
  curlEnd: 680,
  grabEnd: 700,
};
const PAGE_TIMING: Timing = {
  riseStart: 230,
  riseEnd: 560,
  flyStart: 360,
  swap: 620,
  curlStart: 590,
  curlEnd: 740,
  grabEnd: 760,
};
/** Durations the view schedules its own state changes against. */
export const GRAVE_DURATION = { bury: 1_000, release: 450, fade: 400 } as const;

interface Point {
  x: number;
  y: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  size: number;
  soil: boolean;
}
export interface GraveLayout {
  kind: GraveKind;
  scale: number;
  /** Rig scale: the hand reads larger than the hole it climbs from. */
  hand: number;
  timing: Timing;
  hole: Point & { rx: number; ry: number };
  risen: Point;
  buried: Point;
  scrapSize: { width: number; height: number };
  scrapStart: Point & { sx: number; sy: number };
  /** Where a page sheet settles after peeling off the viewport. */
  scrapRest: Point;
  /** Rig-local placement of the held scrap. */
  held: Point & { rotation: number; scale: number };
  debris: Particle[];
  puff: Particle[];
}

interface Transform {
  x: number;
  y: number;
  rotation: number;
  sx: number;
  sy: number;
}
export interface GravePose {
  opacity: number;
  shake: Point;
  crack: number;
  crackAlpha: number;
  open: number;
  /** Milliseconds since the burst, or negative before it. */
  debris: number;
  puff: number;
  rig: Point & { rotation: number };
  curl: number;
  wiggle: number;
  time: number;
  scrap: { mode: 'page' | 'held'; world: Transform; opacity: number; crumple: number };
  mound: number;
  tomb: number;
  restAlpha: number;
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
const inCubic = (x: number): number => x ** 3;
const inOutCubic = (x: number): number => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const outBack = (x: number, overshoot = 1.7): number =>
  1 + (overshoot + 1) * (x - 1) ** 3 + overshoot * (x - 1) ** 2;
const inBack = (x: number, overshoot = 1.5): number =>
  (overshoot + 1) * x ** 3 - overshoot * x ** 2;
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** A fixed seed keeps every burst identical, so reviews and tests see the same frames. */
function particles(count: number, seed: number, scale: number, gentle: boolean): Particle[] {
  let state = seed;
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return Array.from({ length: count }, (_, index) => ({
    x: (random() - 0.5) * 70 * scale,
    y: -random() * 6 * scale,
    vx: (random() - 0.5) * (gentle ? 0.34 : 0.62) * scale,
    vy: -(gentle ? 0.18 + random() * 0.2 : 0.32 + random() * 0.32) * scale,
    spin: (random() - 0.5) * 1.6,
    size: (gentle ? 2.2 + random() * 2 : 2.5 + random() * 3.5) * scale,
    soil: gentle || index % 2 === 1,
  }));
}

export function graveLayout(scene: GraveScene): GraveLayout {
  const width = Math.max(1, scene.viewport.width);
  const height = Math.max(1, scene.viewport.height);
  const scale = clamp(Math.min(width, height) / 760, 0.72, 1);
  const page = scene.kind === 'page';
  const source = scene.source;
  const sourceCenter = {
    x: clamp(source.x + source.width / 2, 0, width),
    y: clamp(source.y + source.height / 2, 0, height),
  };
  const hole = {
    x: page ? width / 2 : clamp(sourceCenter.x, 84 * scale, width - 84 * scale),
    y: page
      ? height - 42 * scale
      : clamp(source.y + source.height + 52 * scale, 176 * scale, height - 26 * scale),
    rx: 68 * scale,
    ry: 20 * scale,
  };
  const scrapSize = page ? { width: 224, height: 128 } : { width: 184, height: 70 };
  return {
    kind: scene.kind,
    scale,
    hand: scale * HAND_SCALE,
    timing: page ? PAGE_TIMING : TEXT_TIMING,
    hole,
    risen: { x: hole.x, y: hole.y - 14 * scale },
    buried: { x: hole.x, y: hole.y + 200 * scale },
    scrapSize,
    scrapStart: page
      ? {
          x: width / 2,
          y: height / 2,
          sx: Math.max(1, (width - 32) / scrapSize.width),
          sy: Math.max(1, (height - 32) / scrapSize.height),
        }
      : { ...sourceCenter, sx: 1, sy: 1 },
    scrapRest: page ? { x: width / 2, y: height / 2 - 30 * scale } : sourceCenter,
    held: page
      ? { x: 0, y: -90, rotation: -5, scale: 0.56 }
      : { x: 2, y: -77, rotation: -6, scale: 0.66 },
    debris: particles(12, 7, scale, false),
    puff: particles(7, 19, scale, true),
  };
}

function rigAt(layout: GraveLayout, t: number): Point & { rotation: number } {
  const { timing } = layout;
  const rise = outBack(progress(t, timing.riseStart, timing.riseEnd), 1.4);
  const settle = outCubic(progress(t, timing.riseEnd, timing.riseEnd + 140));
  const swing = outCubic(progress(t, timing.riseStart, timing.riseEnd));
  const tremble = t > timing.grabEnd ? t - timing.grabEnd : 0;
  return {
    x: layout.risen.x + Math.sin(tremble / 23) * 0.8 * layout.scale,
    y: lerp(layout.buried.y, layout.risen.y, rise) + Math.sin(tremble / 31) * 1.1 * layout.scale,
    rotation: lerp(lerp(-17, 6, swing), -2, settle) + Math.sin(tremble / 19) * 1.3,
  };
}

/** World transform of the held scrap for a given rig pose. */
function heldWorld(layout: GraveLayout, rig: Point & { rotation: number }, crumple = 0): Transform {
  const angle = radians(rig.rotation);
  const x = layout.held.x * layout.hand;
  const y = layout.held.y * layout.hand;
  const scale = layout.held.scale * layout.hand;
  return {
    x: rig.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: rig.y + x * Math.sin(angle) + y * Math.cos(angle),
    rotation: rig.rotation + layout.held.rotation - crumple * 4,
    sx: scale * (1 - crumple * 0.06),
    sy: scale * (1 - crumple * 0.14),
  };
}

function grabPose(layout: GraveLayout, t: number): GravePose {
  const { timing } = layout;
  const shakeAmount = t >= 60 && t <= 280 ? 3 * layout.scale * (1 - (t - 60) / 220) : 0;
  const rig = rigAt(layout, t);
  const curl = 0.12 + 0.88 * inOutCubic(progress(t, timing.curlStart, timing.curlEnd));
  let scrap: GravePose['scrap'];
  if (t < timing.swap) {
    const target = heldWorld(layout, rigAt(layout, timing.swap));
    const fly = inOutCubic(progress(t, timing.flyStart, timing.swap));
    const start = layout.scrapStart;
    let x: number;
    let y: number;
    let sx: number;
    let sy: number;
    let rotation: number;
    let opacity: number;
    if (layout.kind === 'page') {
      // The page sheet peels away from the whole viewport into a card first.
      const peel = outCubic(progress(t, 0, 300));
      x = lerp(start.x, layout.scrapRest.x, peel);
      y = lerp(start.y, layout.scrapRest.y, peel);
      sx = lerp(start.sx, 1, peel);
      sy = lerp(start.sy, 1, peel);
      rotation = lerp(0, -4, peel);
      opacity = progress(t, 0, 220);
    } else {
      // The words tear free of the passage and lift before being snatched.
      const appear = outBack(progress(t, 0, 170), 2);
      const lift = outCubic(progress(t, 90, 320));
      x = start.x;
      y = start.y - lift * 10 * layout.scale;
      sx = lerp(0.55, 1, appear) * (1 + lift * 0.05);
      sy = sx;
      rotation = lift * -4;
      opacity = progress(t, 0, 110);
    }
    scrap = {
      mode: 'page',
      world: {
        x: lerp(x, target.x, fly),
        y: lerp(y, target.y, fly),
        rotation: lerp(rotation, target.rotation, fly),
        sx: lerp(sx, target.sx, fly),
        sy: lerp(sy, target.sy, fly),
      },
      opacity,
      crumple: 0,
    };
  } else {
    const crumple = outCubic(progress(t, timing.swap, timing.swap + 130));
    scrap = { mode: 'held', world: heldWorld(layout, rig, crumple), opacity: 1, crumple };
  }
  return {
    opacity: 1,
    shake: { x: Math.sin(t * 0.9) * shakeAmount, y: Math.cos(t * 1.3) * shakeAmount },
    crack: outCubic(progress(t, 0, 150)),
    crackAlpha: 1,
    open: outBack(progress(t, 50, 300), 1.9),
    debris: t - 80,
    puff: -1,
    rig,
    curl,
    wiggle: 1 - progress(t, timing.curlStart - 60, timing.curlStart + 30),
    time: t,
    scrap,
    mound: 0,
    tomb: 0,
    restAlpha: 1,
  };
}

function buryPose(layout: GraveLayout, u: number, from: GravePose): GravePose {
  const anticipation = outCubic(progress(u, 0, 90)) * -8 * layout.scale;
  const drop = inCubic(progress(u, 90, 480)) * (layout.buried.y - from.rig.y + 24 * layout.scale);
  const rig = {
    x: from.rig.x,
    y: from.rig.y + anticipation + drop,
    rotation: from.rig.rotation - 8 * outCubic(progress(u, 90, 480)),
  };
  const scrap: GravePose['scrap'] =
    from.scrap.mode === 'held'
      ? { ...from.scrap, world: heldWorld(layout, rig, from.scrap.crumple) }
      : {
          ...from.scrap,
          world: { ...from.scrap.world, y: from.scrap.world.y + (rig.y - from.rig.y) },
        };
  const rest = outBack(progress(u, 560, 700), 2.2);
  return {
    ...from,
    shake: { x: 0, y: 0 },
    crackAlpha: from.crackAlpha * (1 - progress(u, 300, 700)),
    open: from.open * (1 - inBack(progress(u, 400, 620))),
    debris: -1,
    puff: u - 380,
    rig,
    wiggle: 0,
    time: from.time + u,
    scrap,
    mound: rest,
    tomb: outBack(progress(u, 610, 750), 2.4),
    restAlpha: 1 - progress(u, 800, GRAVE_DURATION.bury),
  };
}

function releasePose(layout: GraveLayout, u: number, from: GravePose): GravePose {
  const sink = inCubic(progress(u, 110, 380));
  const rig = {
    x: from.rig.x,
    y: lerp(from.rig.y, layout.buried.y, sink),
    rotation: from.rig.rotation + 6 * sink,
  };
  const opening = progress(u, 0, 130);
  const flutter = progress(u, 130, 400);
  // Fingers open first; the scrap then drifts back toward its passage and fades.
  const base = from.scrap.mode === 'held' ? heldWorld(layout, from.rig) : from.scrap.world;
  const scrap: GravePose['scrap'] =
    from.scrap.mode === 'held' && u < 130
      ? { ...from.scrap, world: heldWorld(layout, rig, from.scrap.crumple * (1 - opening)) }
      : {
          mode: 'page',
          world: {
            x: lerp(base.x, layout.scrapRest.x, outCubic(flutter) * 0.6),
            y: lerp(base.y, layout.scrapRest.y, outCubic(flutter) * 0.6),
            rotation: base.rotation + Math.sin(flutter * Math.PI * 2) * 9,
            sx: base.sx,
            sy: base.sy,
          },
          opacity: from.scrap.opacity * (1 - flutter),
          crumple: 0,
        };
  return {
    ...from,
    shake: { x: 0, y: 0 },
    crackAlpha: from.crackAlpha * (1 - progress(u, 200, 440)),
    open: from.open * (1 - inCubic(progress(u, 250, 440))),
    debris: -1,
    puff: -1,
    rig,
    curl: from.curl * (1 - opening),
    wiggle: 0,
    time: from.time + u,
    scrap,
  };
}

export function poseAt(layout: GraveLayout, state: GraveState): GravePose {
  if (state.phase === 'grab') return grabPose(layout, Math.max(0, state.t));
  const u = Math.max(0, state.u);
  if (state.phase === 'bury') return buryPose(layout, u, state.from);
  if (state.phase === 'release') return releasePose(layout, u, state.from);
  return { ...state.from, opacity: state.from.opacity * (1 - progress(u, 0, GRAVE_DURATION.fade)) };
}

// ---------------------------------------------------------------------------
// Rendering

interface FingerSpec {
  x: number;
  y: number;
  splay: number;
  /** A crooked fingertip angle in the open claw. */
  crook: number;
  lengths: [number, number];
  width: number;
  phase: number;
}
// Left hand, palm toward the viewer: thumb on the viewer's left.
const FINGERS: FingerSpec[] = [
  { x: 20, y: -57, splay: 19, crook: 9, lengths: [23, 22], width: 9.5, phase: 2.4 },
  { x: 7, y: -61, splay: 7, crook: -6, lengths: [29, 28], width: 10.8, phase: 1.1 },
  { x: -7, y: -63, splay: -3, crook: 5, lengths: [31, 30], width: 11.2, phase: 0.2 },
  { x: -21, y: -59, splay: -15, crook: -8, lengths: [28, 27], width: 10.8, phase: 3.3 },
];
const THUMB = { x: -27, y: -17, lengths: [22, 21] as [number, number], width: 12.5 };
const SKIN_STROKE = '#232b1d';
/** The rig is drawn this much larger than the hole and debris. */
const HAND_SCALE = 1.3;

/** A bony phalanx: narrow waist, knobbly joint, rounded end. */
function capsule(width: number, length: number, taper = 0.86): string {
  const bottom = width / 2;
  const top = (width * taper) / 2;
  const waist = top * 0.88;
  const knob = Math.max(top, bottom) * 1.06;
  const joint = -length + top * 1.6;
  return `M${-bottom} 4C${-bottom} ${-length * 0.25} ${-waist} ${-length * 0.45} ${-waist} ${-length * 0.6}C${-waist} ${joint + 4} ${-knob} ${joint + 2} ${-knob} ${joint}A${top * 1.04} ${top * 1.2} 0 0 1 ${knob} ${joint}C${knob} ${joint + 2} ${waist} ${joint + 4} ${waist} ${-length * 0.6}C${waist} ${-length * 0.45} ${bottom} ${-length * 0.25} ${bottom} 4Z`;
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
const shade = (rgb: [number, number, number], factor: number): string =>
  `rgb(${rgb.map((channel) => Math.round(clamp(channel * factor, 0, 255))).join(',')})`;

export class GraveEffect {
  readonly element: SVGSVGElement;
  private readonly scene: SVGGElement;
  private readonly clip: SVGPathElement;
  private readonly cracks: SVGPathElement[] = [];
  private readonly crackGroup: SVGGElement;
  private readonly holeBack: SVGGElement;
  private readonly holeFront: SVGGElement;
  private readonly rig: SVGGElement;
  private readonly proximal: SVGGElement[] = [];
  private readonly distal: SVGGElement[] = [];
  private readonly pads: SVGGElement[] = [];
  private readonly backs: SVGGElement[] = [];
  private readonly thumb: [SVGGElement, SVGGElement];
  private readonly pageScrap: SVGGElement;
  private readonly heldScrap: SVGGElement;
  private readonly scrapObjects: SVGForeignObjectElement[] = [];
  private readonly debris: SVGGElement[] = [];
  private readonly puff: SVGGElement[] = [];
  private readonly mound: SVGGElement;
  private readonly tomb: SVGGElement;
  private layout: GraveLayout | null = null;
  private state: GraveState | null = null;
  private startedAt = 0;
  private frame: number | undefined;

  constructor(private readonly document: Document) {
    const svg = <K extends keyof SVGElementTagNameMap>(
      tag: K,
      attributes: Record<string, string | number> = {},
      parent?: Element,
    ): SVGElementTagNameMap[K] => {
      const element = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attributes))
        element.setAttribute(name, String(value));
      parent?.append(element);
      return element;
    };
    this.element = svg('svg', { class: 'grave', 'aria-hidden': 'true' });
    const defs = svg('defs', {}, this.element);
    const gradient = (
      id: string,
      stops: [number, string][],
      attributes: Record<string, string | number> = {},
      tag: 'linearGradient' | 'radialGradient' = 'linearGradient',
    ): void => {
      const element = svg(tag, { id, ...attributes }, defs);
      for (const [offset, color] of stops) svg('stop', { offset, 'stop-color': color }, element);
    };
    gradient('zh-skin', [
      [0, '#5f6f4a'],
      [0.32, '#a3b085'],
      [0.62, '#b8c39a'],
      [1, '#6b7a54'],
    ]);
    gradient(
      'zh-palm',
      [
        [0, '#bcc79d'],
        [0.7, '#97a67c'],
        [1, '#6f7e57'],
      ],
      { cx: 0.45, cy: 0.42, r: 0.65 },
      'radialGradient',
    );
    gradient(
      'zh-nail',
      [
        [0, '#e3d8a8'],
        [1, '#8d7c48'],
      ],
      { x1: 0, y1: 0, x2: 0, y2: 1 },
    );
    gradient('zh-cloth', [
      [0, '#4b423b'],
      [0.5, '#3a322d'],
      [1, '#221d19'],
    ]);
    gradient(
      'zh-pit',
      [
        [0, '#030302'],
        [0.6, '#140e09'],
        [1, '#3b2b1b'],
      ],
      { cx: 0.5, cy: 0.38, r: 0.62 },
      'radialGradient',
    );
    gradient(
      'zh-soil',
      [
        [0, '#7b6143'],
        [1, '#4a3826'],
      ],
      { x1: 0, y1: 0, x2: 0, y2: 1 },
    );
    const clipPath = svg(
      'clipPath',
      { id: 'zh-grave-clip', clipPathUnits: 'userSpaceOnUse' },
      defs,
    );
    this.clip = svg('path', {}, clipPath);

    this.scene = svg('g', { class: 'grave-scene' }, this.element);
    this.crackGroup = svg('g', { class: 'grave-cracks' }, this.scene);
    const crackSpecs: [number, number][] = [
      [-168, 64],
      [-128, 46],
      [-64, 72],
      [-18, 54],
      [22, 40],
      [158, 50],
    ];
    for (const [index, [angle, length]] of crackSpecs.entries()) {
      const points: string[] = ['M0 0'];
      for (let step = 1; step <= 4; step++) {
        const reach = (length * step) / 4;
        const jitter = ((index * 7 + step * 13) % 9) - 4;
        const direction = radians(angle + jitter * 3);
        points.push(
          `L${(Math.cos(direction) * reach).toFixed(1)} ${(Math.sin(direction) * reach * 0.62).toFixed(1)}`,
        );
      }
      this.cracks.push(
        svg('path', { d: points.join(''), pathLength: 1, class: 'crack' }, this.crackGroup),
      );
    }

    this.holeBack = svg('g', { class: 'grave-hole' }, this.scene);
    // The loose scrap stays behind the rising hand, so the hand is never hidden by paper.
    this.pageScrap = svg('g', { class: 'grave-scrap' }, this.scene);
    const clipped = svg('g', { 'clip-path': 'url(#zh-grave-clip)' }, this.scene);
    this.rig = svg('g', { class: 'grave-rig' }, clipped);
    this.holeFront = svg('g', { class: 'grave-lip' }, this.scene);
    const debrisGroup = svg('g', { class: 'grave-debris' }, this.scene);
    const restGroup = svg('g', { class: 'grave-rest' }, this.scene);

    // Forearm and ragged sleeve, then the held scrap, then palm, fingers and
    // thumb: the curled fingers close over the paper's lower half.
    svg(
      'path',
      {
        d: 'M-23 -6C-26 40-29 120-31 210L31 210C29 120 26 40 23 -6Z',
        fill: 'url(#zh-skin)',
        stroke: SKIN_STROKE,
      },
      this.rig,
    );
    svg(
      'path',
      {
        d: 'M-12 52l7 4 5-3 6 3M-14 70l26 1',
        fill: 'none',
        stroke: '#3b4430',
        'stroke-width': 1.2,
        opacity: 0.6,
      },
      this.rig,
    );
    svg(
      'path',
      {
        d: 'M-35 210L-34 16l6-9 5 8 7-12 5 10 6-7 6 9 7-11 5 9 6-8 5 7 5-6 2 2L36 210Z',
        fill: 'url(#zh-cloth)',
        stroke: '#15120f',
      },
      this.rig,
    );
    svg(
      'path',
      {
        d: 'M-22 22l4 30M8 19l-3 26M24 26l2 22',
        stroke: '#1a1612',
        'stroke-width': 1.3,
        fill: 'none',
        opacity: 0.8,
      },
      this.rig,
    );
    this.heldScrap = svg('g', { class: 'grave-scrap held' }, this.rig);
    svg(
      'path',
      {
        d: 'M-23 -2C-30 -18-33 -40-31 -57Q-30 -65-21 -65L21 -65Q31 -65 31 -56C32 -37 30 -17 23 -2Z',
        fill: 'url(#zh-palm)',
        stroke: SKIN_STROKE,
      },
      this.rig,
    );
    svg(
      'path',
      {
        d: 'M-20 -43Q-2 -36 19 -46M-17 -29Q0 -22 16 -31M-4 -60Q-9 -34-2 -8',
        fill: 'none',
        stroke: '#4c5a3c',
        'stroke-width': 1.2,
        opacity: 0.55,
      },
      this.rig,
    );
    svg('ellipse', { cx: 11, cy: -17, rx: 7, ry: 5, fill: '#6e6142', opacity: 0.45 }, this.rig);

    const segment = (parent: SVGGElement, width: number, length: number, tip: boolean): void => {
      if (tip) {
        const pad = svg('g', {}, parent);
        svg(
          'path',
          {
            d: `M${-width * 0.3} ${-length + 4}Q0 ${-length - 10} ${width * 0.3} ${-length + 4}Z`,
            fill: 'url(#zh-nail)',
            stroke: '#4a3f24',
            'stroke-width': 1,
          },
          pad,
        );
        svg('path', { d: capsule(width, length), fill: 'url(#zh-skin)', stroke: SKIN_STROKE }, pad);
        svg(
          'path',
          {
            d: `M${-width * 0.28} ${-length * 0.45}q${width * 0.28} 2 ${width * 0.56} 0`,
            fill: 'none',
            stroke: '#45523a',
            'stroke-width': 1,
            opacity: 0.6,
          },
          pad,
        );
        const back = svg('g', { visibility: 'hidden' }, parent);
        svg(
          'path',
          { d: capsule(width, length), fill: 'url(#zh-skin)', stroke: SKIN_STROKE },
          back,
        );
        svg(
          'rect',
          {
            x: -width * 0.32,
            y: -length + 1,
            width: width * 0.64,
            height: 11,
            rx: 3,
            fill: 'url(#zh-nail)',
            stroke: '#4a3f24',
            'stroke-width': 1,
          },
          back,
        );
        svg(
          'path',
          {
            d: `M${-width * 0.3} ${-length + 3}h${width * 0.6}`,
            stroke: '#3a311b',
            'stroke-width': 2,
          },
          back,
        );
        this.pads.push(pad);
        this.backs.push(back);
        return;
      }
      svg(
        'path',
        { d: capsule(width, length, 0.92), fill: 'url(#zh-skin)', stroke: SKIN_STROKE },
        parent,
      );
      svg(
        'path',
        {
          d: `M${-width * 0.32} ${-length + 3}q${width * 0.32} -3 ${width * 0.64} 0`,
          fill: 'none',
          stroke: '#3c4832',
          'stroke-width': 1.1,
          opacity: 0.7,
        },
        parent,
      );
      svg(
        'path',
        {
          d: `M${-width * 0.26} ${-length * 0.5}q${width * 0.26} 2 ${width * 0.52} 0`,
          fill: 'none',
          stroke: '#45523a',
          'stroke-width': 1,
          opacity: 0.6,
        },
        parent,
      );
    };
    for (const finger of FINGERS) {
      const base = svg('g', { transform: `translate(${finger.x} ${finger.y})` }, this.rig);
      const proximal = svg('g', {}, base);
      segment(proximal, finger.width, finger.lengths[0], false);
      const joint = svg('g', { transform: `translate(0 ${-finger.lengths[0]})` }, proximal);
      const distal = svg('g', {}, joint);
      segment(distal, finger.width * 0.94, finger.lengths[1], true);
      this.proximal.push(proximal);
      this.distal.push(distal);
    }

    const thumbBase = svg('g', { transform: `translate(${THUMB.x} ${THUMB.y})` }, this.rig);
    const thumbProximal = svg('g', {}, thumbBase);
    segment(thumbProximal, THUMB.width, THUMB.lengths[0], false);
    const thumbJoint = svg('g', { transform: `translate(0 ${-THUMB.lengths[0]})` }, thumbProximal);
    const thumbDistal = svg('g', {}, thumbJoint);
    segment(thumbDistal, THUMB.width * 0.92, THUMB.lengths[1], true);
    // The thumb never flips, so its pad stays visible.
    this.pads.pop();
    this.backs.pop()?.remove();
    this.thumb = [thumbProximal, thumbDistal];
    for (const [group, scrap] of [
      [this.pageScrap, 'page'],
      [this.heldScrap, 'held'],
    ] as const) {
      const object = svg('foreignObject', { class: `scrap-${scrap}` }, group);
      this.scrapObjects.push(object);
    }

    for (const particle of [...particles(12, 7, 1, false), ...particles(7, 19, 1, true)]) {
      const group = svg('g', { opacity: 0 }, debrisGroup);
      if (particle.soil) svg('circle', { r: 1, class: 'clod' }, group);
      else svg('path', { d: 'M-1 -0.7L1.1 -0.2L-0.2 1Z', class: 'shard' }, group);
      (this.debris.length < 12 ? this.debris : this.puff).push(group);
    }
    this.mound = svg('g', { opacity: 0 }, restGroup);
    svg(
      'path',
      {
        d: 'M-42 0Q-30 -15 0 -16Q30 -15 42 0Z',
        fill: 'url(#zh-soil)',
        stroke: '#33261a',
        'stroke-width': 1.2,
      },
      this.mound,
    );
    this.tomb = svg('g', { opacity: 0 }, restGroup);
    svg(
      'path',
      {
        d: 'M-9 0V-15A9 9 0 0 1 9 -15V0Z',
        fill: '#a9aea5',
        stroke: '#3a3e37',
        'stroke-width': 1.4,
      },
      this.tomb,
    );
    svg(
      'path',
      { d: 'M0 -19V-6M-4 -14H4', stroke: '#4d524a', 'stroke-width': 1.6, fill: 'none' },
      this.tomb,
    );
    this.element.setAttribute('hidden', '');
  }

  /** Begin a new grab. Any previous scene is discarded. */
  start(scene: GraveScene): void {
    this.layout = graveLayout(scene);
    const { width, height } = scene.viewport;
    this.element.setAttribute('width', String(width));
    this.element.setAttribute('height', String(height));
    this.element.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const rgb = parseColor(scene.style?.background) ?? [246, 243, 234];
    const ink = scene.style?.color ?? '#28301f';
    this.element.style.setProperty('--paper', shade(rgb, 1));
    this.element.style.setProperty('--paper-ink', ink);
    this.element.style.setProperty('--crack', ink);
    if (scene.style?.fontFamily)
      this.element.style.setProperty('--paper-font', scene.style.fontFamily);
    else this.element.style.removeProperty('--paper-font');
    this.buildHole(rgb);
    this.fillScrap(scene);
    this.state = { phase: 'grab', t: 0 };
    this.startedAt = this.now();
    this.element.removeAttribute('hidden');
    this.render();
    this.loop();
  }

  bury(): void {
    this.transition('bury');
  }

  release(): void {
    this.transition('release');
  }

  fade(): void {
    this.transition('fade');
  }

  /** Render one still pose without running the loop (reduced motion). */
  hold(): void {
    if (!this.layout) return;
    this.stop();
    this.state = { phase: 'grab', t: this.layout.timing.grabEnd };
    this.paint(poseAt(this.layout, this.state));
  }

  hide(): void {
    this.stop();
    this.layout = null;
    this.state = null;
    this.element.setAttribute('hidden', '');
  }

  get active(): boolean {
    return this.layout !== null;
  }

  /** Milliseconds from start until the scrap is firmly held. */
  get grabEnd(): number {
    return this.layout?.timing.grabEnd ?? 0;
  }

  private now(): number {
    return this.document.defaultView?.performance.now() ?? 0;
  }

  private current(): GraveState | null {
    if (!this.state) return null;
    const elapsed = this.now() - this.startedAt;
    return this.state.phase === 'grab'
      ? { phase: 'grab', t: elapsed }
      : { ...this.state, u: elapsed };
  }

  private transition(phase: 'bury' | 'release' | 'fade'): void {
    const current = this.current();
    if (!this.layout || !current) return;
    const from = poseAt(this.layout, current);
    this.state = { phase, u: 0, from };
    this.startedAt = this.now();
    this.render();
    this.loop();
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
    this.paint(poseAt(this.layout, state));
  }

  private buildHole(rgb: [number, number, number]): void {
    const layout = this.layout;
    if (!layout) return;
    const { rx, ry } = layout.hole;
    const paper = shade(rgb, 1);
    const underside = shade(rgb, 0.8);
    const edge = shade(rgb, 0.55);
    const svg = (tag: string, attributes: Record<string, string | number>, parent: Element) => {
      const element = this.document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attributes))
        element.setAttribute(name, String(value));
      parent.append(element);
      return element;
    };
    this.holeBack.replaceChildren();
    this.holeFront.replaceChildren();
    svg('ellipse', { rx: rx * 1.22, ry: ry * 1.5, fill: '#5b4630', opacity: 0.45 }, this.holeBack);
    const flap = (angle: number, spread: number, reach: number, parent: Element, fill: string) => {
      const point = (theta: number, factor = 1) =>
        `${(Math.cos(theta) * rx * factor).toFixed(1)} ${(Math.sin(theta) * ry * factor).toFixed(1)}`;
      const theta = radians(angle);
      svg(
        'path',
        {
          d: `M${point(theta - radians(spread))}L${point(theta, 1 + reach)}L${point(theta + radians(spread))}Z`,
          fill,
          stroke: edge,
          'stroke-width': 1,
          'stroke-linejoin': 'round',
        },
        parent,
      );
    };
    for (const [angle, spread, reach] of [
      [196, 15, 0.42],
      [226, 13, 0.72],
      [262, 16, 0.95],
      [300, 12, 0.7],
      [334, 15, 0.46],
    ] as const)
      flap(angle, spread, reach, this.holeBack, paper);
    svg(
      'ellipse',
      { rx, ry, fill: 'url(#zh-pit)', stroke: '#2c2116', 'stroke-width': 2.5 },
      this.holeBack,
    );
    svg(
      'path',
      {
        d: `M${-rx} 0A${rx} ${ry} 0 0 0 ${rx} 0`,
        fill: 'none',
        stroke: '#4a3826',
        'stroke-width': 4,
        'stroke-linecap': 'round',
      },
      this.holeFront,
    );
    for (const [angle, spread, reach] of [
      [22, 13, 0.6],
      [62, 15, 1.1],
      [104, 14, 0.9],
      [146, 13, 0.62],
    ] as const)
      flap(angle, spread, reach, this.holeFront, underside);
    for (const [x, y, r] of [
      [-0.78, 0.55, 3.4],
      [-0.3, 0.98, 2.6],
      [0.42, 0.9, 3.8],
      [0.86, 0.4, 2.8],
    ] as const)
      svg(
        'circle',
        {
          cx: x * rx,
          cy: y * ry,
          r: r * layout.scale,
          fill: '#5d4730',
          stroke: '#2e2318',
          'stroke-width': 0.8,
        },
        this.holeFront,
      );
  }

  private fillScrap(scene: GraveScene): void {
    const layout = this.layout;
    if (!layout) return;
    const { width, height } = layout.scrapSize;
    const host = scene.detail ?? '';
    for (const object of this.scrapObjects) {
      object.setAttribute('x', String(-width / 2));
      object.setAttribute('y', String(-height / 2));
      object.setAttribute('width', String(width));
      object.setAttribute('height', String(height));
      const slip = this.document.createElementNS(XHTML, 'div') as HTMLDivElement;
      slip.className = `slip ${scene.kind}`;
      const words = this.document.createElementNS(XHTML, 'p') as HTMLParagraphElement;
      words.className = 'grabbed';
      words.textContent = scene.text.slice(0, 220) || 'Source reference';
      slip.append(words);
      if (scene.kind === 'page') {
        const detail = this.document.createElementNS(XHTML, 'p') as HTMLParagraphElement;
        detail.className = 'host';
        detail.textContent = host.slice(0, 80);
        slip.append(detail);
        for (let line = 0; line < 3; line++) slip.append(this.document.createElementNS(XHTML, 'i'));
      }
      object.replaceChildren(slip);
    }
  }

  private paint(pose: GravePose): void {
    const layout = this.layout;
    if (!layout) return;
    const { hole, scale } = layout;
    const fixed = (value: number) => value.toFixed(2);
    this.scene.setAttribute('opacity', fixed(pose.opacity));
    this.scene.setAttribute(
      'transform',
      `translate(${fixed(pose.shake.x)} ${fixed(pose.shake.y)})`,
    );

    this.crackGroup.setAttribute(
      'transform',
      `translate(${fixed(hole.x)} ${fixed(hole.y)}) scale(${fixed(scale)})`,
    );
    this.crackGroup.setAttribute('opacity', fixed(pose.crackAlpha * 0.7));
    for (const crack of this.cracks) crack.setAttribute('stroke-dashoffset', fixed(1 - pose.crack));

    const open = Math.max(0, pose.open);
    const holeTransform = `translate(${fixed(hole.x)} ${fixed(hole.y)}) scale(${fixed(open)})`;
    this.holeBack.setAttribute('transform', holeTransform);
    this.holeFront.setAttribute('transform', holeTransform);
    const rx = hole.rx * open;
    const ry = hole.ry * open;
    // Everything above the hole's centre line, plus the opening itself: an arm
    // below the front lip is underground.
    this.clip.setAttribute(
      'd',
      `M-99999 -99999H99999V${fixed(hole.y)}H-99999Z${
        rx > 0.5
          ? `M${fixed(hole.x - rx)} ${fixed(hole.y)}a${fixed(rx)} ${fixed(ry)} 0 1 0 ${fixed(2 * rx)} 0a${fixed(rx)} ${fixed(ry)} 0 1 0 ${fixed(-2 * rx)} 0Z`
          : ''
      }`,
    );

    this.rig.setAttribute(
      'transform',
      `translate(${fixed(pose.rig.x)} ${fixed(pose.rig.y)}) rotate(${fixed(pose.rig.rotation)}) scale(${fixed(layout.hand)})`,
    );
    const curl = pose.curl;
    for (const [index, finger] of FINGERS.entries()) {
      const twitch = pose.wiggle * Math.sin(pose.time / 42 + finger.phase);
      // Curling toward the viewer foreshortens the finger; past the fold the
      // fingertip hangs down over the paper. The fingertip's own scale undoes
      // its parent's foreshortening so its visible length stays honest.
      const proximalScale = 1 - 0.55 * curl;
      const visible = 1 - 1.85 * curl;
      const distalScale =
        (Math.abs(visible) < 0.04 ? 0.04 * Math.sign(visible || 1) : visible) / proximalScale;
      this.proximal[index]?.setAttribute(
        'transform',
        `rotate(${fixed(finger.splay * (1 - 0.85 * curl) + twitch * 7)}) scale(1 ${fixed(proximalScale)})`,
      );
      this.distal[index]?.setAttribute(
        'transform',
        `rotate(${fixed(finger.crook * (1 - curl) + twitch * 5)}) scale(1 ${fixed(distalScale)})`,
      );
      // Past the fold, the back of the fingertip (and its nail) faces the viewer.
      this.pads[index]?.setAttribute('visibility', distalScale >= 0 ? 'visible' : 'hidden');
      this.backs[index]?.setAttribute('visibility', distalScale >= 0 ? 'hidden' : 'visible');
    }
    this.thumb[0].setAttribute(
      'transform',
      `rotate(${fixed(lerp(-50, 30, curl))}) scale(1 ${fixed(1 - 0.22 * curl)})`,
    );
    this.thumb[1].setAttribute('transform', `rotate(${fixed(lerp(8, 46, curl))})`);

    const held = pose.scrap.mode === 'held';
    const scrapTransform = (transform: Transform) =>
      `translate(${fixed(transform.x)} ${fixed(transform.y)}) rotate(${fixed(transform.rotation)}) scale(${fixed(transform.sx)} ${fixed(transform.sy)})`;
    this.pageScrap.setAttribute('visibility', held ? 'hidden' : 'visible');
    this.pageScrap.setAttribute('opacity', fixed(pose.scrap.opacity));
    this.pageScrap.setAttribute('transform', scrapTransform(pose.scrap.world));
    this.heldScrap.setAttribute('visibility', held ? 'visible' : 'hidden');
    const local = layout.held;
    this.heldScrap.setAttribute(
      'transform',
      `translate(${local.x} ${local.y}) rotate(${fixed(local.rotation - pose.scrap.crumple * 4)}) scale(${fixed(local.scale * (1 - pose.scrap.crumple * 0.06))} ${fixed(local.scale * (1 - pose.scrap.crumple * 0.14))})`,
    );

    const gravity = 0.0021 * scale;
    const throwParticles = (
      groups: SVGGElement[],
      specs: Particle[],
      elapsed: number,
      life: number,
    ) => {
      for (const [index, group] of groups.entries()) {
        const particle = specs[index];
        if (!particle || elapsed < 0 || elapsed > life) {
          group.setAttribute('opacity', '0');
          continue;
        }
        const x = hole.x + particle.x + particle.vx * elapsed;
        const y = hole.y + particle.y + particle.vy * elapsed + 0.5 * gravity * elapsed ** 2;
        group.setAttribute('opacity', fixed(1 - progress(elapsed, life * 0.6, life)));
        group.setAttribute(
          'transform',
          `translate(${fixed(x)} ${fixed(y)}) rotate(${fixed(particle.spin * elapsed)}) scale(${fixed(particle.size)})`,
        );
      }
    };
    throwParticles(this.debris, layout.debris, pose.debris, 640);
    throwParticles(this.puff, layout.puff, pose.puff, 420);

    const rest = `translate(${fixed(hole.x)} ${fixed(hole.y + 4 * scale)})`;
    this.mound.setAttribute('opacity', fixed(Math.min(1, pose.mound) * pose.restAlpha));
    this.mound.setAttribute(
      'transform',
      `${rest} scale(${fixed(scale)} ${fixed(scale * pose.mound)})`,
    );
    this.tomb.setAttribute('opacity', fixed(Math.min(1, pose.tomb) * pose.restAlpha));
    this.tomb.setAttribute(
      'transform',
      `${rest} translate(${fixed(-14 * scale)} ${fixed(-6 * scale)}) scale(${fixed(scale * Math.max(0, pose.tomb))})`,
    );
  }
}
