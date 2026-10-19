import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GRAVE_DURATION,
  type GraveKind,
  type GraveLayout,
  type GravePose,
  type GraveRect,
  graveClip,
  graveLayout,
  poseAt,
  spriteFrame,
} from '../../src/ui/grave';
import { GRAVE_SPRITE } from '../../src/ui/grave-sprite';

const viewports = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 320, height: 480 },
];
const passage = { x: 400, y: 200, width: 300, height: 30 };

function layoutFor(
  kind: GraveKind,
  viewport = viewports[0] as { width: number; height: number },
  source: GraveRect = passage,
): GraveLayout {
  return graveLayout({
    kind,
    source: kind === 'page' ? { x: 0, y: 0, ...viewport } : source,
    viewport,
    text: 'A garden remembers the seeds we plant.',
  });
}
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('grave choreography invariants', () => {
  it('keeps the grave inside the viewport wherever the passage sits', () => {
    let checked = 0;
    for (const viewport of viewports)
      for (const across of [0, 0.5, 1])
        for (const down of [0, 0.5, 1])
          for (const kind of ['text', 'page'] as const) {
            const source = {
              x: across * (viewport.width - 120),
              y: down * (viewport.height - 24),
              width: 120,
              height: 24,
            };
            const { hole } = layoutFor(kind, viewport, source);
            expect(hole.x - hole.rx).toBeGreaterThanOrEqual(0);
            expect(hole.x + hole.rx).toBeLessThanOrEqual(viewport.width);
            expect(hole.y - hole.ry).toBeGreaterThanOrEqual(0);
            expect(hole.y + hole.ry).toBeLessThanOrEqual(viewport.height);
            checked += 1;
          }
    expect(checked).toBe(viewports.length * 9 * 2);
  });

  it('tears the grave open just below a passage, and at the foot of the page for a page grab', () => {
    const text = layoutFor('text');
    expect(text.hole.x).toBe(passage.x + passage.width / 2);
    expect(text.hole.y).toBeGreaterThan(passage.y + passage.height);
    expect(text.hole.y - (passage.y + passage.height)).toBeLessThan(80);
    const page = layoutFor('page');
    expect(page.hole.x).toBe(640);
    expect(page.hole.y).toBeGreaterThan(700);
  });

  it.each(['text', 'page'] as const)(
    'carries the %s copy into the hand without a jump and closes the fist on it',
    (kind) => {
      const layout = layoutFor(kind);
      const { swap, grabEnd } = layout.timing;
      const before = poseAt(layout, { phase: 'grab', t: swap - 1 });
      const after = poseAt(layout, { phase: 'grab', t: swap });
      expect(before.scrap.mode).toBe('page');
      expect(after.scrap.mode).toBe('held');
      expect(distance(before.scrap.world, after.scrap.world)).toBeLessThan(6);
      const held = poseAt(layout, { phase: 'grab', t: grabEnd });
      expect(held.scrap).toMatchObject({ mode: 'held', opacity: 1 });
      expect(held.curl).toBeCloseTo(1, 5);
      expect(held.rig.y).toBeLessThan(layout.hole.y);
      expect(held.scrap.world.y).toBeLessThan(layout.hole.y);
    },
  );

  it.each(['text', 'page'] as const)(
    'drags the held %s copy under and leaves nothing on the page',
    (kind) => {
      const layout = layoutFor(kind);
      const from = poseAt(layout, { phase: 'grab', t: layout.timing.grabEnd + 300 });
      const under = poseAt(layout, { phase: 'bury', u: 480, from });
      expect(under.rig.y).toBeGreaterThan(layout.hole.y);
      expect(under.scrap.world.y).toBeGreaterThan(layout.hole.y);
      const gone = poseAt(layout, { phase: 'bury', u: GRAVE_DURATION.bury, from });
      expect(gone.open).toBeCloseTo(0, 9);
      expect(gone.restAlpha).toBe(0);
    },
  );

  it('lets go on failure: the fingers open, the copy drifts back and fades, the hand sinks', () => {
    const layout = layoutFor('text');
    const from = poseAt(layout, { phase: 'grab', t: layout.timing.grabEnd + 100 });
    const drifting = poseAt(layout, { phase: 'release', u: 300, from });
    expect(distance(drifting.scrap.world, layout.scrapRest)).toBeLessThan(
      distance(from.scrap.world, layout.scrapRest),
    );
    const end = poseAt(layout, { phase: 'release', u: GRAVE_DURATION.release, from });
    expect(end.curl).toBe(0);
    expect(end.scrap.opacity).toBe(0);
    expect(end.rig.y).toBeCloseTo(layout.buried.y, 6);
    expect(end.open).toBeCloseTo(0, 9);
  });

  it.each(['text', 'page'] as const)(
    'plays the %s rise in order, closes the fist on the grab and opens it again on release',
    (kind) => {
      const layout = layoutFor(kind);
      const { rise, grab } = GRAVE_SPRITE;
      const frames: number[] = [];
      for (let t = 0; t <= layout.timing.grabEnd; t += 5)
        frames.push(spriteFrame(poseAt(layout, { phase: 'grab', t })));
      expect(frames[0]).toBe(0);
      expect(frames.every((frame, index) => index === 0 || frame >= (frames[index - 1] ?? 0))).toBe(
        true,
      );
      // Every frame is shown: no rendered pose is skipped at this pace.
      expect(new Set(frames).size).toBe(rise + grab);
      expect(frames.at(-1)).toBe(rise + grab - 1);
      const from = poseAt(layout, { phase: 'grab', t: layout.timing.grabEnd + 100 });
      const buried = poseAt(layout, { phase: 'bury', u: GRAVE_DURATION.bury, from });
      expect(spriteFrame(buried)).toBe(rise + grab - 1);
      const released = poseAt(layout, { phase: 'release', u: GRAVE_DURATION.release, from });
      expect(spriteFrame(released)).toBe(rise - 1);
    },
  );

  it('grips the copy where the rendered fist closes', () => {
    const fist = GRAVE_SPRITE.grip[GRAVE_SPRITE.grip.length - 1];
    for (const kind of ['text', 'page'] as const)
      expect(layoutFor(kind).held).toMatchObject({ x: fist?.x, y: fist?.y });
  });

  it('never lifts the cut end of the rendered forearm out of the grave', () => {
    const { frame, anchor, unitsPerPx } = GRAVE_SPRITE;
    const below = (frame.height - anchor.y) * unitsPerPx;
    const corners = [-anchor.x * unitsPerPx, (frame.width - anchor.x) * unitsPerPx];
    const check = (layout: GraveLayout, pose: GravePose): void => {
      const angle = (pose.rig.rotation * Math.PI) / 180;
      const lowest = Math.min(
        ...corners.map(
          (x) => pose.rig.y + (x * Math.sin(angle) + below * Math.cos(angle)) * layout.hand,
        ),
      );
      // Anything below the hole's lowest edge is clipped away underground.
      expect(lowest).toBeGreaterThan(layout.hole.y + layout.hole.ry * Math.max(0, pose.open));
    };
    let checked = 0;
    for (const viewport of viewports)
      for (const kind of ['text', 'page'] as const) {
        const layout = layoutFor(kind, viewport);
        for (let t = 0; t <= layout.timing.grabEnd + 900; t += 10) {
          const from = poseAt(layout, { phase: 'grab', t });
          check(layout, from);
          for (let u = 0; u <= GRAVE_DURATION.bury; u += 50) {
            check(layout, poseAt(layout, { phase: 'bury', u, from }));
            check(layout, poseAt(layout, { phase: 'release', u, from }));
          }
          checked += 1;
        }
      }
    expect(checked).toBeGreaterThan(500);
  });

  it('ships an atlas whose dimensions match the frame metadata', () => {
    const bytes = readFileSync(new URL('../../assets/grave-hand.webp', import.meta.url));
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 16)).toBe('WEBPVP8X');
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    const { frame, columns, rise, grab } = GRAVE_SPRITE;
    expect(width).toBe(frame.width * columns);
    expect(height).toBe(frame.height * Math.ceil((rise + grab) / columns));
    expect(GRAVE_SPRITE.grip).toHaveLength(grab);
  });

  it('keeps the arm visible across the whole opening, not only below its centre line', () => {
    const [x, y, rx, ry] = [400, 300, 68, 20];
    const path = graveClip(x, y, rx, ry);
    const arcs = [...path.matchAll(/a[\d.]+ [\d.]+ 0 1 ([01]) ([-\d.]+) 0/gu)];
    expect(arcs).toHaveLength(2);
    // Polygonise per the SVG arc rules: endpoints on a horizontal diameter put the
    // centre at their midpoint, and sweep-flag 1 walks the angle upwards.
    const ellipse: [number, number][] = [];
    let start = Math.PI;
    for (const arc of arcs) {
      const direction = arc[1] === '1' ? 1 : -1;
      for (let step = 0; step < 32; step++) {
        const angle = start + (direction * Math.PI * step) / 32;
        ellipse.push([x + rx * Math.cos(angle), y + ry * Math.sin(angle)]);
      }
      start += direction * Math.PI;
    }
    const ground: [number, number][] = [
      [-99999, -99999],
      [99999, -99999],
      [99999, y],
      [-99999, y],
    ];
    const winding = (point: [number, number], polygon: [number, number][]): number => {
      let total = 0;
      for (const [index, [ax, ay]] of polygon.entries()) {
        const [bx, by] = polygon[(index + 1) % polygon.length] ?? [ax, ay];
        const side = (bx - ax) * (point[1] - ay) - (point[0] - ax) * (by - ay);
        if (ay <= point[1] && by > point[1] && side > 0) total += 1;
        if (ay > point[1] && by <= point[1] && side < 0) total -= 1;
      }
      return total;
    };
    const visible = (point: [number, number]) =>
      winding(point, ground) + winding(point, ellipse) !== 0;
    expect(visible([x, y - ry / 2])).toBe(true); // back half of the opening
    expect(visible([x + rx / 2, y - ry / 3])).toBe(true);
    expect(visible([x, y + ry / 2])).toBe(true); // front half of the opening
    expect(visible([x, y - 200])).toBe(true); // open air above the page
    expect(visible([x, y + ry + 4])).toBe(false); // underground, below the front lip
    expect(visible([x + rx + 4, y + 4])).toBe(false);
  });

  it('fades any pose out completely', () => {
    const layout = layoutFor('page');
    const from = poseAt(layout, { phase: 'grab', t: 400 });
    expect(poseAt(layout, { phase: 'fade', u: GRAVE_DURATION.fade, from }).opacity).toBe(0);
  });
});
