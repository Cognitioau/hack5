import { describe, expect, it } from 'vitest';
import {
  GestureTracker,
  isCircle,
  isShake,
  type GesturePoint,
} from '../../src/core/domain/gestures';

const anchor: GesturePoint = { x: 400, y: 300, at: 0 };
const orbit = (direction = 1, radius = 55, turns = 1): GesturePoint[] =>
  Array.from({ length: 65 }, (_, index) => {
    const angle = ((direction * index) / 64) * Math.PI * 2 * turns;
    return {
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
      at: index * 13,
    };
  });
const shake: GesturePoint[] = [0, 55, -40, 50, -50, 40].map((x, index) => ({
  x: anchor.x + x,
  y: anchor.y + (index % 3),
  at: index * 90,
}));

describe('deliberate gesture recognition', () => {
  it.each([1, -1])(
    'accepts a full circle in direction %s, after initial outward movement',
    (direction) => {
      const outward = [0, 6, 12, 18, 25, 35, 45].map((x, index) => ({
        x: anchor.x + x,
        y: anchor.y,
        at: index * 10,
      }));
      const circle = orbit(direction).map((point) => ({ ...point, at: point.at + 70 }));
      expect(isCircle([...outward, ...circle], anchor)).toBe(true);
    },
  );

  it('does not confuse an incomplete arc, tiny jitter or a sparse jump with confirmation', () => {
    expect(isCircle(orbit(1, 55, 0.65), anchor)).toBe(false);
    expect(isCircle(orbit(1, 10), anchor)).toBe(false);
    const jumps = orbit().filter((_, index) => index < 20 || index > 52);
    expect(isCircle(jumps, anchor)).toBe(false);
    expect(isCircle(orbit(1, 260), anchor)).toBe(false);
  });

  it('requires a mostly consistent direction and a bounded duration', () => {
    const alternating = orbit().flatMap((point, index) => [
      point,
      { ...(orbit()[Math.max(0, index - 4)] ?? point), at: point.at + 1 },
    ]);
    expect(isCircle(alternating, anchor)).toBe(false);
    expect(
      isCircle(
        orbit().map((point) => ({ ...point, at: point.at * 8 })),
        anchor,
      ),
    ).toBe(false);
  });

  it('recognizes horizontal, vertical and diagonal shakes without counting a circle', () => {
    expect(isShake(shake)).toBe(true);
    expect(isShake(shake.map((point) => ({ ...point, x: point.y, y: point.x })))).toBe(true);
    expect(isShake(shake.map((point) => ({ ...point, x: point.x, y: point.x })))).toBe(true);
    expect(isShake(orbit())).toBe(false);
    expect(isShake(shake.slice(0, 3))).toBe(false);
    expect(isShake(shake.map((point) => ({ ...point, at: point.at * 10 })))).toBe(false);
  });

  it('supports cancel-only pending-save mode, with no circle confirmation', () => {
    const pending = new GestureTracker(anchor);
    expect(orbit().map((point) => pending.add(point, false))).not.toContain('confirm');
    const pendingShake = new GestureTracker(anchor);
    expect(shake.map((point) => pendingShake.add(point, false))).toContain('cancel');
  });

  it('rejects non-finite and time-reversed input', () => {
    const tracker = new GestureTracker(anchor);
    expect(tracker.add({ x: Number.NaN, y: 1, at: 0 })).toBe('none');
    expect(tracker.add({ x: 450, y: 300, at: 50 })).toBe('none');
    expect(tracker.add({ x: 390, y: 310, at: 49 })).toBe('none');
  });
});
