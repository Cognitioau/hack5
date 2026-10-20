/**
 * The paper copy's crumple: a pure model of the sheet the hand tears off the
 * page and balls up in its fist. The view cuts the flat sheet into a grid of
 * triangles and maps each onto its facet here, shaded by the light from the
 * upper left that lights the footage.
 */

export type SheetKind = 'text' | 'page';

export interface PaperPose {
  /** 0 flat on the page, 1 balled up in the fist. */
  crumple: number;
  /** 0 lying on the page, 1 torn free and lifted toward the viewer. */
  lift: number;
  /** Footage steps; the loose ends flutter with them. */
  step: number;
}

export interface Facet {
  /** Its triangle of the flat sheet, in sheet px, grown a little so neighbours overlap. */
  clip: [number, number][];
  /** CSS matrix(a, b, c, d, e, f) taking the flat sheet onto the facet. */
  matrix: [number, number, number, number, number, number];
  /** Brightness against lying flat: below 1 turned from the light, above 1 toward it. */
  light: number;
  /** The sheet's blank back faces the viewer. */
  back: boolean;
  /** Height of the facet's centre toward the viewer; paint the lowest first. */
  depth: number;
}

/** Cells across and down each kind of sheet. */
export const PAPER_GRID: Readonly<Record<SheetKind, readonly [number, number]>> = {
  text: [10, 2],
  page: [6, 4],
};
/** Neighbouring facets overlap by this much (sheet px), so no seam shows between them. */
const OVERLAP = 1.2;

type Vector = [number, number, number];
const unitVector = ([x, y, z]: Vector): Vector => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};
/** Toward the light: up, left and in front, as in the footage. */
const LIGHT = unitVector([-0.45, -0.6, 0.66]);

/** A fixed hash of a lattice point to -1..1, so every crumple is the same. */
function hash(x: number, y: number, channel: number): number {
  let h = Math.imul(x, 374_761_393) ^ Math.imul(y, 668_265_263) ^ Math.imul(channel, 1_274_126_177);
  h = Math.imul(h ^ (h >>> 13), 1_103_515_245);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_647.5 - 1;
}

/** Smooth value noise in -1..1. */
function noise(x: number, y: number, channel: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const row = (at: number) =>
    hash(ix, at, channel) + (hash(ix + 1, at, channel) - hash(ix, at, channel)) * fx;
  return row(iy) + (row(iy + 1) - row(iy)) * fy;
}

/** Where a point of the flat sheet ends up: sheet px across and down, and height toward the viewer. */
function bend(x: number, y: number, width: number, height: number, pose: PaperPose): Vector {
  const { crumple, lift, step } = pose;
  // Crease spacing, and the size of the ball it makes: it scales with the sheet's area.
  const unit = Math.sqrt(width * height) / 4;
  const dx = x - width / 2;
  const dy = y - height / 2;
  const n = (channel: number) => noise(x / (1.5 * unit), y / (1.5 * unit), channel);
  // Balled up, it shrinks toward the fist, unevenly, the long way most.
  let across = dx * (1 - 0.62 * crumple * (1 + 0.2 * n(1))) + 0.35 * unit * crumple * n(2);
  let down = dy * (1 - 0.4 * crumple * (1 + 0.3 * n(3))) + 0.35 * unit * crumple * n(4);
  // Pleats along it and across it as it bends, then creases at random as it
  // is crushed.
  let toward =
    crumple *
      unit *
      (0.8 * Math.sin((2 * Math.PI * x) / (2.2 * unit) + 1.3) +
        0.5 * Math.sin((2 * Math.PI * y) / (2.6 * unit) + 0.4)) +
    crumple ** 2 * unit * 0.9 * n(5);
  // Its loose ends curl toward the viewer and droop, and flutter as the arm moves.
  const end = Math.min(1, Math.abs(dx) / (width / 2)) ** 2;
  toward += crumple * unit * end * (1.2 + 0.3 * Math.sin(step * 0.9 + x / unit));
  down += crumple * unit * end * (0.5 + 0.2 * Math.sin(step * 0.7 + x / unit + 1));
  // Torn free, it lifts off the page, the end away from the fist first.
  toward += lift * unit * (0.6 + 0.8 * (1 - crumple) * Math.max(0, -dx / (width / 2)));
  // A little perspective: what lifts toward the viewer grows.
  const near = (16 * unit) / (16 * unit - Math.min(toward, 6 * unit));
  across *= near;
  down *= near;
  return [width / 2 + across, height / 2 + down, toward];
}

const minus = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector, b: Vector): Vector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** The sheet's triangles in the pose, two to each grid cell. */
export function paperFacets(
  kind: SheetKind,
  width: number,
  height: number,
  pose: PaperPose,
): Facet[] {
  const [columns, rows] = PAPER_GRID[kind];
  const xs = Array.from({ length: columns + 1 }, (_, i) => (width * i) / columns);
  const ys = Array.from({ length: rows + 1 }, (_, j) => (height * j) / rows);
  const points = ys.map((y) => xs.map((x) => bend(x, y, width, height, pose)));
  const at = (i: number, j: number) => points[j]?.[i] as Vector;
  const facets: Facet[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const [x0, x1] = [xs[i] as number, xs[i + 1] as number];
      const [y0, y1] = [ys[j] as number, ys[j + 1] as number];
      // Each cell's two triangles, from their right-angled corner: the upper
      // left one, then the lower right one, running the other way.
      for (const [corner, along, down, sign] of [
        [[i, j], [i + 1, j], [i, j + 1], 1],
        [[i + 1, j + 1], [i, j + 1], [i + 1, j], -1],
      ] as const) {
        const origin = at(...corner);
        const p = minus(at(...along), origin);
        const q = minus(at(...down), origin);
        const a = p[0] / (sign * (x1 - x0));
        const b = p[1] / (sign * (x1 - x0));
        const c = q[0] / (sign * (y1 - y0));
        const d = q[1] / (sign * (y1 - y0));
        const rest: [number, number][] = [
          [xs[corner[0]] as number, ys[corner[1]] as number],
          [xs[along[0]] as number, ys[along[1]] as number],
          [xs[down[0]] as number, ys[down[1]] as number],
        ];
        const [rx, ry] = rest[0] as [number, number];
        const normal = unitVector(cross(p, q));
        const back = a * d - b * c < 0;
        const facing = back ? -1 : 1;
        const lit =
          (facing * (normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2])) /
          LIGHT[2];
        const cx = rest.reduce((sum, [x]) => sum + x, 0) / 3;
        const cy = rest.reduce((sum, [, y]) => sum + y, 0) / 3;
        facets.push({
          clip: rest.map(([x, y]) => {
            const reach = Math.hypot(x - cx, y - cy) || 1;
            return [x + ((x - cx) / reach) * OVERLAP * 1.5, y + ((y - cy) / reach) * OVERLAP * 1.5];
          }),
          matrix: [a, b, c, d, origin[0] - a * rx - c * ry, origin[1] - b * rx - d * ry],
          light: Math.max(0, lit),
          back,
          depth: (origin[2] + at(...along)[2] + at(...down)[2]) / 3,
        });
      }
    }
  return facets;
}

/**
 * A torn outline for a sheet, as a CSS polygon: fibrous along its long edges,
 * rougher where it was torn off at the ends.
 */
export function tornEdge(kind: SheetKind): string {
  const [long, short, bite, end] = kind === 'text' ? [30, 6, 9, 3] : [34, 14, 4, 2];
  const ragged = (t: number, channel: number, depth: number) =>
    depth *
    (0.5 + 0.35 * noise(t * 6, 0.5, channel) + 0.15 * hash(Math.round(t * 400), 1, channel));
  const points: [number, number][] = [];
  for (let k = 0; k < long; k++) points.push([(100 * k) / long, ragged(k / long, 1, bite)]);
  for (let k = 0; k < short; k++) points.push([100 - ragged(k / short, 2, end), (100 * k) / short]);
  for (let k = long; k > 0; k--) points.push([(100 * k) / long, 100 - ragged(k / long, 3, bite)]);
  for (let k = short; k > 0; k--) points.push([ragged(k / short, 4, end), (100 * k) / short]);
  return `polygon(${points.map(([x, y]) => `${x.toFixed(1)}% ${y.toFixed(1)}%`).join(',')})`;
}
