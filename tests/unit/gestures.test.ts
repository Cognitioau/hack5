import { describe, expect, it } from 'vitest';
import {
  CircleGestureTracker,
  GestureTracker,
  isCircle,
  isShake,
  stalledMoves,
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

describe('modifier-held circle geometry', () => {
  function trace(points: GesturePoint[]): {
    decisions: string[];
    center: { x: number; y: number } | null;
  } {
    const tracker = new CircleGestureTracker();
    const decisions = points.map((point) => tracker.add(point));
    return { decisions, center: tracker.getCenter() };
  }

  it.each([1, -1])('fits a circle beginning on its rim, direction %s', (direction) => {
    const result = trace(orbit(direction));
    expect(result.decisions.filter((decision) => decision === 'confirm')).toHaveLength(1);
    expect(result.center?.x).toBeCloseTo(anchor.x, 0);
    expect(result.center?.y).toBeCloseTo(anchor.y, 0);
  });

  it.each([0, Math.PI / 5, Math.PI / 2])(
    'accepts a moderately elongated oval at angle %s',
    (tilt) => {
      const points = orbit().map((point) => {
        const x = (point.x - anchor.x) * 2.2;
        const y = point.y - anchor.y;
        return {
          ...point,
          x: anchor.x + x * Math.cos(tilt) - y * Math.sin(tilt),
          y: anchor.y + x * Math.sin(tilt) + y * Math.cos(tilt),
        };
      });
      expect(trace(points).decisions).toContain('confirm');
    },
  );

  it('allows a center-out approach without requiring it', () => {
    const approach = Array.from({ length: 9 }, (_, index) => ({
      x: anchor.x + index * 6,
      y: anchor.y,
      at: index * 12,
    }));
    expect(
      trace([...approach, ...orbit().map((point) => ({ ...point, at: point.at + 110 }))]).decisions,
    ).toContain('confirm');
  });

  it('offers a provisional center only after a meaningful two-dimensional path', () => {
    const tracker = new CircleGestureTracker();
    for (const point of orbit().slice(0, 7)) tracker.add(point);
    expect(tracker.getCenter()).toBeNull();
    for (const point of orbit().slice(7, 24)) tracker.add(point);
    expect(tracker.getCenter()).not.toBeNull();
    expect(trace(shake).decisions).toContain('cancel');
    expect(trace(shake).center).toBeNull();
  });

  // Hand-drawn loops rarely close: they stop short, spiral in or out, wobble or overshoot.
  const drawn = (
    radiusAt: (turn: number) => number,
    turns: number,
    { samples = 65, duration = 840, jitter = 0 } = {},
  ): GesturePoint[] =>
    Array.from({ length: samples }, (_, index) => {
      const turn = (index / (samples - 1)) * turns;
      const angle = turn * Math.PI * 2;
      // A hand wavers a few times round a loop, not from one sample to the next.
      const radius = 55 * radiusAt(turn) + jitter * Math.sin(turn * Math.PI * 2 * 5);
      return {
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius,
        at: (index / (samples - 1)) * duration,
      };
    });
  it.each([
    ['stops a little short of closing', drawn(() => 1, 0.86)],
    ['spirals inward, ending well inside its start', drawn((turn) => 1 - 0.32 * turn, 1)],
    ['spirals outward, ending well outside its start', drawn((turn) => 1 + 0.4 * turn, 1)],
    ['is lopsided, like an egg', drawn((turn) => 1 + 0.32 * Math.cos(turn * Math.PI * 2), 0.92)],
    ['wobbles as a hand does', drawn(() => 1, 0.9, { jitter: 7 })],
    ['overshoots its start', drawn((turn) => 1 - 0.15 * turn, 1.2)],
    [
      'curls in tightly',
      drawn(() => 1, 1).map((point, index) => ({
        ...point,
        x: anchor.x + (point.x - anchor.x) * (1 - index / 90),
        y: anchor.y + (point.y - anchor.y) * (1 - index / 90),
      })),
    ],
    ['is quick and sparsely sampled', drawn(() => 1, 0.9, { samples: 22, duration: 330 })],
  ])('confirms a loop that %s', (_, points) => {
    expect(trace(points).decisions).toContain('confirm');
  });

  it('confirms a loop wide or tall enough to go round a column of text', () => {
    const stretched = (across: number, down: number): GesturePoint[] =>
      orbit().map((point) => ({
        ...point,
        x: anchor.x + ((point.x - anchor.x) / 55) * across,
        y: anchor.y + ((point.y - anchor.y) / 55) * down,
      }));
    expect(trace(stretched(400, 180)).decisions).toContain('confirm');
    expect(trace(stretched(160, 460)).decisions).toContain('confirm');
  });

  it('rejects incomplete arcs, jitter, huge swipes, flat loops and missing arcs', () => {
    const rejected = [
      orbit(1, 55, 0.7),
      orbit(1, 18),
      orbit(1, 520),
      orbit().map((point) => ({ ...point, y: anchor.y + (point.y - anchor.y) / 4 })),
      orbit().filter((_, index) => index < 19 || index > 43),
    ];
    for (const points of rejected) expect(trace(points).decisions).not.toContain('confirm');
  });

  it('rejects a loop traced back and forth', () => {
    const backtracking = orbit().flatMap((point, index) => [
      { ...(orbit()[Math.max(0, index - 5)] ?? point), at: point.at },
      { ...point, at: point.at + 1 },
    ]);
    expect(trace(backtracking).decisions).not.toContain('confirm');
  });

  it('requires an actual tracing duration and does not slide past a timed-out prefix', () => {
    expect(
      trace(orbit().map((point) => ({ ...point, at: point.at / 10 }))).decisions,
    ).not.toContain('confirm');
    expect(trace(orbit().map((point) => ({ ...point, at: point.at * 8 }))).decisions).not.toContain(
      'confirm',
    );
    expect(
      trace([
        { x: 455, y: 300, at: 0 },
        ...orbit().map((point) => ({ ...point, at: point.at + 4_001 })),
      ]).decisions,
    ).not.toContain('confirm');
  });

  it('hands back the whole attempt as its loop, from its first point, thinned when dense', () => {
    const tracker = new CircleGestureTracker();
    const dense = Array.from({ length: 721 }, (_, index) => ({
      x: anchor.x + Math.cos((index / 720) * Math.PI * 2) * 200,
      y: anchor.y + Math.sin((index / 720) * Math.PI * 2) * 200,
      at: index * 4,
    }));
    const added: GesturePoint[] = [];
    for (const point of dense) {
      added.push(point);
      if (tracker.add(point) === 'confirm') break;
    }
    const loop = tracker.getLoop();
    expect(loop.length).toBeLessThanOrEqual(256);
    expect(loop[0]).toEqual(dense[0]);
    expect(loop.at(-1)).toEqual(added.at(-1));
    // Thinned evenly: no stretch of the loop is lost.
    const gaps = loop.slice(1).map((point, index) => point.at - (loop[index]?.at ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(4 * 8);
    const fresh = new CircleGestureTracker();
    for (const point of orbit().slice(0, 30)) fresh.add(point);
    expect(fresh.getLoop()).toEqual(orbit().slice(0, 30));
  });

  it('keeps a loop drawn while the page was busy whole, from the moves merged into one event', () => {
    // A second's loop, sampled every 16 ms, with a 200 ms stall a third of
    // the way round: Chrome hands the moves made meanwhile to the next event.
    const loop = Array.from({ length: 64 }, (_, index) => {
      const angle = (index / 63) * Math.PI * 2;
      return {
        x: anchor.x + Math.cos(angle) * 120,
        y: anchor.y + Math.sin(angle) * 80,
        at: index * 16,
      };
    });
    const stall = loop.filter((point) => point.at > 300 && point.at < 500);
    const after = loop.filter((point) => point.at <= 300 || point.at >= 500);
    expect(trace(after).decisions).not.toContain('confirm');
    const tracker = new CircleGestureTracker();
    const decisions: string[] = [];
    let last = Number.NEGATIVE_INFINITY;
    for (const point of after) {
      for (const move of stalledMoves([...stall].reverse(), last, point.at))
        decisions.push(tracker.add(move));
      decisions.push(tracker.add(point));
      last = point.at;
    }
    expect(decisions).toContain('confirm');
    // An event after no stall adds nothing, and only moves since the last point count.
    expect(stalledMoves(stall, 300, 320)).toEqual([]);
    expect(stalledMoves(loop, 300, 400).map((move) => move.at)).toEqual([
      304, 320, 336, 352, 368, 384,
    ]);
    expect(stalledMoves([{ x: Number.NaN, y: 0, at: 350 }], 300, 400)).toEqual([]);
  });

  it('ignores malformed and time-reversed input and bounds dense samples', () => {
    const tracker = new CircleGestureTracker();
    expect(tracker.add({ x: Number.POSITIVE_INFINITY, y: 0, at: 0 })).toBe('none');
    expect(tracker.add({ x: 455, y: 300, at: 20 })).toBe('none');
    expect(tracker.add({ x: 0, y: 0, at: 19 })).toBe('none');
    expect(tracker.getCenter()).toBeNull();
    const dense = Array.from({ length: 721 }, (_, index) => ({
      x: anchor.x + Math.cos((index / 720) * Math.PI * 2) * 200,
      y: anchor.y + Math.sin((index / 720) * Math.PI * 2) * 200,
      at: index * 4,
    }));
    expect(trace(dense).decisions).toContain('confirm');
  });
});
