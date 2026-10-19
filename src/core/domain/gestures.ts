/** Viewport coordinates only: callers own document identity and trusted input. */
export interface GesturePoint {
  x: number;
  y: number;
  at: number;
}

export type GestureDecision = 'none' | 'confirm' | 'cancel';

const distance = (a: GesturePoint, b: GesturePoint): number => Math.hypot(a.x - b.x, a.y - b.y);

const angleDifference = (current: number, previous: number): number => {
  let difference = current - previous;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
};

/** A closed, mostly one-directional orbit around the locked arm point. */
export function isCircle(points: readonly GesturePoint[], anchor: GesturePoint): boolean {
  const rim = points.filter((point) => distance(point, anchor) >= 18);
  if (rim.length < 16) return false;
  const first = rim[0];
  const last = rim.at(-1);
  if (!first || !last || last.at - first.at > 4_000 || last.at - first.at < 180) return false;

  let rotation = 0;
  let travel = 0;
  let previousAngle = Math.atan2(first.y - anchor.y, first.x - anchor.x);
  const radii: number[] = [];
  const quadrants = new Set<number>();
  for (const point of rim) {
    const radius = distance(point, anchor);
    if (radius > 220) return false;
    radii.push(radius);
    const angle = Math.atan2(point.y - anchor.y, point.x - anchor.x);
    const change = angleDifference(angle, previousAngle);
    // A jump cannot supply a missing arc, even if the endpoints happen to fit.
    if (Math.abs(change) > Math.PI / 2) return false;
    rotation += change;
    travel += Math.abs(change);
    previousAngle = angle;
    quadrants.add(Math.floor((angle + Math.PI) / (Math.PI / 2)) % 4);
  }
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  const radialDeviation = Math.sqrt(
    radii.reduce((sum, radius) => sum + (radius - meanRadius) ** 2, 0) / radii.length,
  );
  return (
    quadrants.size === 4 &&
    Math.abs(rotation) >= Math.PI * 1.82 &&
    Math.abs(rotation) / Math.max(travel, 0.001) >= 0.84 &&
    radialDeviation / meanRadius <= 0.42 &&
    distance(first, last) <= Math.max(24, meanRadius * 0.7)
  );
}

/** A deliberate linear shake: four substantial alternating strokes in 900 ms. */
export function isShake(points: readonly GesturePoint[]): boolean {
  const last = points.at(-1);
  if (!last) return false;
  const recent = points.filter((point) => last.at - point.at <= 900);
  if (recent.length < 5) return false;
  const meanX = recent.reduce((sum, point) => sum + point.x, 0) / recent.length;
  const meanY = recent.reduce((sum, point) => sum + point.y, 0) / recent.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of recent) {
    const x = point.x - meanX;
    const y = point.y - meanY;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const directionAngle = Math.atan2(2 * xy, xx - yy) / 2;
  const cos = Math.cos(directionAngle);
  const sin = Math.sin(directionAngle);
  const values = recent.map((point) => (point.x - meanX) * cos + (point.y - meanY) * sin);
  const perpendicular = recent.map((point) => -(point.x - meanX) * sin + (point.y - meanY) * cos);
  const majorSpan = Math.max(...values) - Math.min(...values);
  const minorSpan = Math.max(...perpendicular) - Math.min(...perpendicular);
  if (majorSpan < 36 || minorSpan > majorSpan * 0.3 + 8) return false;
  let pivot = values[0] ?? 0;
  let extreme = pivot;
  let direction = 0;
  let reversals = 0;
  let travelled = 0;
  for (const value of values.slice(1)) {
    if (direction === 0) {
      if (Math.abs(value - pivot) >= 18) {
        direction = Math.sign(value - pivot);
        extreme = value;
      }
      continue;
    }
    if ((value - extreme) * direction >= 0) {
      extreme = value;
    } else if (Math.abs(value - extreme) >= 18) {
      travelled += Math.abs(extreme - pivot);
      pivot = extreme;
      extreme = value;
      direction *= -1;
      reversals += 1;
    }
  }
  return reversals >= 3 && travelled >= 100;
}

/** Bounded per-operation recognizer; reset when its operation ends. */
export class GestureTracker {
  private points: GesturePoint[] = [];

  constructor(private readonly anchor: GesturePoint) {}

  add(point: GesturePoint, allowConfirm = true): GestureDecision {
    if (![point.x, point.y, point.at].every(Number.isFinite)) return 'none';
    const previous = this.points.at(-1);
    if (previous && point.at < previous.at) return 'none';
    if (previous && distance(previous, point) < 2) return 'none';
    this.points.push(point);
    this.points = this.points.filter((entry) => point.at - entry.at <= 4_000).slice(-256);
    if (allowConfirm && isCircle(this.points, this.anchor)) return 'confirm';
    if (isShake(this.points)) return 'cancel';
    return 'none';
  }
}
