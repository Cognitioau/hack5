import { describe, expect, it } from 'vitest';
import {
  GRAVE_DURATION,
  type GraveKind,
  type GraveLayout,
  type GraveRect,
  graveLayout,
  poseAt,
} from '../../src/ui/grave';

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

  it('fades any pose out completely', () => {
    const layout = layoutFor('page');
    const from = poseAt(layout, { phase: 'grab', t: 400 });
    expect(poseAt(layout, { phase: 'fade', u: GRAVE_DURATION.fade, from }).opacity).toBe(0);
  });
});
