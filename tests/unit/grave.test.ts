import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buryDuration,
  footageBlend,
  footageFrame,
  GRAVE_DURATION,
  type GraveKind,
  type GraveLayout,
  type GravePose,
  type GraveRect,
  grabEndFor,
  graveLayout,
  healAt,
  pickHand,
  poseAt,
  releaseDuration,
  rimLift,
  scrapAt,
  splitFrames,
  tintChannel,
} from '../../src/ui/grave';
import { GRAVE_HANDS } from '../../src/ui/grave-sprite';
import { PAPER_GRID, paperFacets, type SheetKind } from '../../src/ui/paper';

const viewports = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 320, height: 480 },
];
const passage = { x: 400, y: 200, width: 300, height: 30 };
const hands = GRAVE_HANDS.map((_, index) => index);
/** Steps of cracks before the first footage frame. */
const PRE = 5;

function layoutFor(
  kind: GraveKind,
  hand = 0,
  viewport = viewports[0] as { width: number; height: number },
  source: GraveRect = passage,
  fontSize = 17,
): GraveLayout {
  return graveLayout(
    {
      kind,
      source: kind === 'page' ? { x: 0, y: 0, ...viewport } : source,
      viewport,
      text: 'A garden remembers the seeds we plant.',
      style: {
        fontFamily: 'Georgia, serif',
        color: 'rgb(35, 34, 31)',
        background: 'rgb(255, 255, 255)',
        fontSize,
      },
    },
    hand,
  );
}
const fistPose = (layout: GraveLayout): GravePose =>
  poseAt(layout, { phase: 'grab', t: grabEndFor(layout.hand) + 400 });
const onPage = (layout: GraveLayout, point: { x: number; y: number }) => ({
  x: layout.place.x + point.x * layout.scale,
  y: layout.place.y + point.y * layout.scale,
});
/** The source frames an edit in scripts/hand/takes.json picks, as matte.py reads it. */
const picks = (edit: string): number[] =>
  edit.split(',').flatMap((part) => {
    const [span = '', step = '1'] = part.split(':');
    const [first = '', last = first] = span.split('-');
    const [from, to, every] = [Number(first), Number(last), Number(step)];
    return Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, k) =>
      Math.floor(from + k * every + 0.5),
    );
  });

describe('packaged grave hands', () => {
  it.each(hands)('packs hand %i as a run of WebP frames matching its metadata', (index) => {
    const hand = GRAVE_HANDS[index];
    if (!hand) throw new Error('Missing hand');
    const bytes = new Uint8Array(readFileSync(new URL(`../../${hand.path}`, import.meta.url)));
    const frames = splitFrames(bytes);
    // The take's frames, then its heal's.
    expect(hand.heal).toBeGreaterThan(0);
    expect(frames).toHaveLength(hand.frames + hand.heal);
    expect(hand.grip).toHaveLength(hand.frames);
    for (const frame of frames) {
      const header = Buffer.from(frame.subarray(0, 30));
      expect(header.toString('ascii', 0, 4)).toBe('RIFF');
      expect(header.toString('ascii', 8, 16)).toBe('WEBPVP8X');
      // Every frame carries alpha: the hand at the declared size, and the wall
      // behind it beside it.
      expect((header[20] ?? 0) & 0x10).toBe(0x10);
      expect(1 + header.readUIntLE(24, 3)).toBe(2 * hand.size.width);
      expect(1 + header.readUIntLE(27, 3)).toBe(hand.size.height);
    }
    const { slam, take, fist } = hand.beats;
    expect(0 < slam && slam < take && take < fist && fist < hand.frames).toBe(true);
    for (const beat of [slam, take, fist]) expect(hand.grip[beat]).not.toBeNull();
    expect(hand.hole.x).toBeGreaterThan(0);
    expect(hand.hole.x).toBeLessThan(hand.size.width);
    expect(hand.hole.y).toBeLessThan(hand.size.height);
  });

  it('ships one hand per footage take, in take order', () => {
    const { takes, heal } = JSON.parse(
      readFileSync(new URL('../../scripts/hand/takes.json', import.meta.url), 'utf8'),
    ) as {
      takes: { edit: string; beats: { slam: number; take: number; fist: number } }[];
      heal: { edit: string };
    };
    expect(GRAVE_HANDS.map((hand) => hand.path)).toEqual(
      takes.map((_, index) => `assets/grave-hand-${index}.bin`),
    );
    expect(GRAVE_HANDS.map((hand) => hand.frames)).toEqual(
      takes.map((take) => picks(take.edit).length),
    );
    expect(GRAVE_HANDS.map((hand) => hand.beats)).toEqual(takes.map((take) => take.beats));
    // One heal, matted onto every take.
    expect(GRAVE_HANDS.map((hand) => hand.heal)).toEqual(takes.map(() => picks(heal.edit).length));
  });

  it('refuses anything but a whole run of WebP frames', () => {
    const frame = (payload: number[]) => {
      const bytes = new Uint8Array(12 + payload.length);
      bytes.set([82, 73, 70, 70]);
      new DataView(bytes.buffer).setUint32(4, 4 + payload.length, true);
      bytes.set([87, 69, 66, 80], 8);
      bytes.set(payload, 12);
      return [...bytes];
    };
    expect(splitFrames(new Uint8Array([...frame([1, 2]), ...frame([3, 4, 5, 6])]))).toHaveLength(2);
    expect(() => splitFrames(new Uint8Array([...frame([1, 2]), 0, 0]))).toThrow();
    expect(() => splitFrames(new Uint8Array(frame([1, 2]).slice(0, 13)))).toThrow();
    expect(() =>
      splitFrames(new Uint8Array([60, 104, 116, 109, 108, 62, 0, 0, 0, 0, 0, 0])),
    ).toThrow();
  });
});

describe('grave choreography invariants', () => {
  it('never plays the same hand twice in a row, and plays every hand', () => {
    expect(GRAVE_HANDS.length).toBeGreaterThan(1);
    const seen = new Set<number>();
    let previous: number | undefined;
    for (let grab = 0; grab < 300; grab++) {
      const hand = pickHand(previous);
      expect(hand).not.toBe(previous);
      expect(GRAVE_HANDS[hand]).toBeDefined();
      seen.add(hand);
      previous = hand;
    }
    expect(seen.size).toBe(GRAVE_HANDS.length);
    for (const edge of [0, 0.999_999_999])
      for (const last of [undefined, ...hands]) {
        const hand = pickHand(last, () => edge);
        expect(GRAVE_HANDS[hand]).toBeDefined();
        expect(hand).not.toBe(last);
      }
  });

  it('keeps the hole on screen wherever the passage sits', () => {
    let checked = 0;
    for (const hand of hands)
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
              const { hole } = layoutFor(kind, hand, viewport, source);
              const crater = hole.r * 1.5;
              expect(hole.x - crater).toBeGreaterThanOrEqual(0);
              expect(hole.x + crater).toBeLessThanOrEqual(viewport.width);
              expect(hole.y - crater).toBeGreaterThanOrEqual(0);
              expect(hole.y + crater).toBeLessThanOrEqual(viewport.height);
              checked += 1;
            }
    expect(checked).toBe(hands.length * viewports.length * 9 * 2);
  });

  it.each(hands)('closes hand %i on the passage when there is room below it', (index) => {
    const layout = layoutFor('text', index);
    const fist = layout.hand.grip[layout.hand.beats.fist];
    if (!fist) throw new Error('No fist');
    const closed = onPage(layout, fist);
    expect(closed.x).toBeCloseTo(passage.x + passage.width / 2, 6);
    expect(closed.y).toBeCloseTo(passage.y + passage.height / 2, 6);
    // The hole opens below the words, and the hand reaches up from it.
    expect(layout.hole.y).toBeGreaterThan(passage.y + passage.height);
  });

  it.each(hands)(
    'closes hand %i on the visible part of a passage that runs off screen',
    (index) => {
      // A long selection from above the viewport: only its lower 300px are on screen.
      const tall = { x: 100, y: -400, width: 560, height: 700 };
      const layout = layoutFor('text', index, viewports[0], tall);
      const fist = layout.hand.grip[layout.hand.beats.fist];
      if (!fist) throw new Error('No fist');
      const closed = onPage(layout, fist);
      expect(closed.x).toBeCloseTo(380, 6);
      expect(closed.y).toBeCloseTo(150, 6);
    },
  );

  it('sizes the hand from the reading text, within limits', () => {
    const across = (layout: GraveLayout) => layout.hand.source * layout.scale;
    expect(across(layoutFor('text', 0, viewports[0], passage, 17))).toBeCloseTo(260, 6);
    expect(across(layoutFor('text', 1, viewports[0], passage, 17))).toBeCloseTo(260, 6);
    expect(across(layoutFor('text', 0, viewports[0], passage, 20))).toBeGreaterThan(260);
    expect(across(layoutFor('text', 0, viewports[0], passage, 40))).toBeCloseTo(320, 6);
    expect(across(layoutFor('text', 0, viewports[0], passage, 8))).toBeCloseTo(180, 6);
    const phone = viewports[3] as { width: number; height: number };
    const small = layoutFor('text', 0, phone, { x: 100, y: 100, width: 80, height: 20 });
    expect(across(small)).toBeLessThanOrEqual(phone.width * 0.75);
    // Near the foot of the viewport the hand shrinks rather than losing its hole.
    const low = layoutFor('text', 0, viewports[0], { ...passage, y: 740 });
    expect(across(low)).toBeLessThan(260);
  });

  it.each(hands)(
    'plays hand %i forwards to the fist and holds it until the save answers',
    (index) => {
      const layout = layoutFor('text', index);
      const { hand } = layout;
      const end = grabEndFor(hand);
      // A fifth faster than it was filmed: no take keeps the words waiting 1.8 s.
      expect(end).toBeLessThan(1_800);
      const frames: (number | null)[] = [];
      for (let t = 0; t <= end + 2_000; t += 5)
        frames.push(footageFrame(layout, poseAt(layout, { phase: 'grab', t }).step));
      // Cracks first, then every frame in order up to the closed fist.
      expect(frames[0]).toBeNull();
      const shown = frames.filter((frame): frame is number => frame !== null);
      expect(shown.every((frame, at) => at === 0 || frame >= (shown[at - 1] ?? 0))).toBe(true);
      expect(new Set(shown).size).toBe(hand.beats.fist + 1);
      expect(footageFrame(layout, poseAt(layout, { phase: 'grab', t: end }).step)).toBe(
        hand.beats.fist,
      );
      expect(shown.at(-1)).toBe(hand.beats.fist);
    },
  );

  it.each(hands)('buries hand %i: the copy goes through the hole, which heals', (index) => {
    const layout = layoutFor('text', index);
    const from = fistPose(layout);
    expect(scrapAt(layout, from.step).visible).toBe(true);
    const duration = buryDuration(layout, from);
    // The yank, then the heal.
    expect(duration).toBeGreaterThan(1_000);
    expect(duration).toBeLessThan(2_000);
    let last = from.step;
    for (let u = 0; u <= duration; u += 10) {
      const pose = poseAt(layout, { phase: 'bury', u, from });
      expect(pose.step).toBeGreaterThanOrEqual(last);
      last = pose.step;
    }
    const end = poseAt(layout, { phase: 'bury', u: duration, from });
    expect(footageFrame(layout, end.step)).toBe(layout.hand.frames + layout.hand.heal - 1);
    expect(healAt(layout, end.step)).toBe(1);
    expect(scrapAt(layout, end.step).visible).toBe(false);
  });

  it.each(hands)('heals hand %i’s hole with every heal frame, once the hand is gone', (index) => {
    const layout = layoutFor('text', index);
    const { hand } = layout;
    const from = fistPose(layout);
    const duration = buryDuration(layout, from);
    const shown: number[] = [];
    const times = Array.from({ length: Math.floor(duration / 5) + 1 }, (_, k) => k * 5);
    for (const u of [...times, duration]) {
      const { step } = poseAt(layout, { phase: 'bury', u, from });
      const frame = footageFrame(layout, step);
      if (frame === null) throw new Error('The footage went blank');
      // The heal starts only after the take's last frame, the empty hole.
      if (frame < hand.frames) expect(healAt(layout, step)).toBe(0);
      else expect(healAt(layout, step)).toBeGreaterThanOrEqual(0);
      shown.push(frame);
    }
    expect(shown.every((frame, at) => at === 0 || frame >= (shown[at - 1] ?? 0))).toBe(true);
    // From the fist, every frame of the yank and then of the heal, in order.
    const first = hand.beats.fist;
    expect([...new Set(shown)]).toEqual(
      Array.from({ length: hand.frames + hand.heal - first }, (_, k) => first + k),
    );
    expect(healAt(layout, PRE + hand.frames)).toBe(0);
    expect(healAt(layout, PRE + hand.frames + hand.heal - 1)).toBe(1);
  });

  it.each(hands)(
    'mixes hand %i’s frames toward the next by how far each step has come',
    (index) => {
      const layout = layoutFor('text', index);
      const last = layout.hand.frames + layout.hand.heal - 1;
      expect(footageBlend(layout, PRE - 0.5)).toBeNull();
      expect(footageBlend(layout, PRE)).toEqual({ frame: 0, next: null, amount: 0 });
      expect(footageBlend(layout, PRE + 10.25)).toEqual({ frame: 10, next: 11, amount: 0.25 });
      // The take's last frame, the empty hole, runs on into the heal's first.
      const into = layout.hand.frames - 1;
      expect(footageBlend(layout, PRE + into + 0.5)).toEqual({
        frame: into,
        next: into + 1,
        amount: 0.5,
      });
      // Nothing follows the healed wall.
      expect(footageBlend(layout, PRE + last + 0.5)).toEqual({
        frame: last,
        next: null,
        amount: 0,
      });
      for (let step = 0; step < PRE + last + 2; step += 0.13)
        expect(footageBlend(layout, step)?.frame ?? null).toBe(footageFrame(layout, step));
    },
  );

  it.each(hands)('carries the copy between hand %i’s frames, not in their jumps', (index) => {
    const layout = layoutFor('text', index);
    const { grip, beats } = layout.hand;
    let checked = 0;
    // From the moment it is held until the fist is pulled back through the hole.
    for (let frame = beats.take + 4; frame + 1 < layout.hand.frames; frame++) {
      const [from, to] = [grip[frame], grip[frame + 1]];
      if (!from || !to || (from.x === to.x && from.y === to.y)) continue;
      const between = scrapAt(layout, PRE + frame + 0.5);
      expect(between.x).toBeCloseTo(
        (onPage(layout, from).x + onPage(layout, to).x) / 2 - 21 * layout.scale,
        6,
      );
      expect(between.y).toBeCloseTo((onPage(layout, from).y + onPage(layout, to).y) / 2, 6);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each(['text', 'page'] as const)(
    'releases a %s grab by rewinding it quickly, putting the words back',
    (kind) => {
      for (const index of hands) {
        const layout = layoutFor(kind, index);
        const from = fistPose(layout);
        const duration = releaseDuration(from);
        expect(duration).toBeLessThanOrEqual(450);
        const midway = poseAt(layout, { phase: 'release', u: duration / 2, from });
        expect(midway.step).toBeLessThan(from.step);
        // Rewinding never throws debris back into the hole.
        expect(midway.forward).toBe(false);
        const end = poseAt(layout, { phase: 'release', u: duration, from });
        expect(end.step).toBe(0);
        expect(footageFrame(layout, end.step)).toBeNull();
        if (kind === 'text') expect(scrapAt(layout, end.step).visible).toBe(false);
      }
    },
  );

  it.each(hands)('hands the words to the fingers of hand %i as they close', (index) => {
    const layout = layoutFor('text', index);
    const { take, fist } = layout.hand.beats;
    expect(scrapAt(layout, PRE + take - 1).visible).toBe(false);
    // The copy starts flat on the words, then is torn free and balled up as
    // the fingers close.
    expect(scrapAt(layout, PRE + take)).toMatchObject({
      visible: true,
      ...layout.word,
      crumple: 0,
      lift: 0,
    });
    const held = scrapAt(layout, PRE + take + 4);
    const grip = layout.hand.grip[take + 4];
    if (!grip) throw new Error('No grip');
    expect(held.x).toBeCloseTo(onPage(layout, grip).x - 21 * layout.scale, 6);
    expect(held.y).toBeCloseTo(onPage(layout, grip).y, 6);
    expect(held.lift).toBe(1);
    expect(held.crumple).toBeGreaterThan(0.5);
    expect(scrapAt(layout, PRE + fist).crumple).toBeGreaterThan(0.95);
  });

  it.each(['text', 'page'] as const)(
    'bends the %s copy without tearing it, and balls it up into creases',
    (kind: SheetKind) => {
      const [width, height] = kind === 'text' ? [204, 26] : [168, 96];
      const [columns, rows] = PAPER_GRID[kind];
      // Flat, every facet lies where it was cut from, so the mesh can take over
      // from the flat copy without a jump.
      for (const facet of paperFacets(kind, width, height, { crumple: 0, lift: 0, step: 0 })) {
        facet.matrix.forEach((value, at) => {
          expect(value).toBeCloseTo([1, 0, 0, 1, 0, 0][at] ?? 0, 9);
        });
        expect(facet.light).toBeCloseTo(1, 9);
        expect(facet.back).toBe(false);
      }
      // Its paper as the viewer sees it, folds and all.
      const seen = (facets: ReturnType<typeof paperFacets>) =>
        (facets.reduce((sum, { matrix: [a, b, c, d] }) => sum + Math.abs(a * d - b * c), 0) *
          width *
          height) /
        facets.length;
      let previous = width * height;
      for (const crumple of [0.25, 0.5, 0.75, 1]) {
        const facets = paperFacets(kind, width, height, { crumple, lift: 1, step: 40 });
        expect(facets).toHaveLength(2 * columns * rows);
        expect(facets.flatMap(({ matrix }) => matrix).every(Number.isFinite)).toBe(true);
        // Every facet meeting at a corner of the grid puts it in the same
        // place: the sheet folds but never splits. Each cell holds its upper
        // left triangle, then its lower right one.
        const corners = new Map<string, [number, number][]>();
        facets.forEach(({ matrix: [a, b, c, d, e, f] }, at) => {
          const cell = Math.floor(at / 2);
          const [i, j] = [cell % columns, Math.floor(cell / columns)];
          const own: [number, number][] =
            at % 2 === 0
              ? [
                  [i, j],
                  [i + 1, j],
                  [i, j + 1],
                ]
              : [
                  [i + 1, j + 1],
                  [i, j + 1],
                  [i + 1, j],
                ];
          for (const [ci, cj] of own) {
            const [x, y] = [(width * ci) / columns, (height * cj) / rows];
            const placed = corners.get(`${ci},${cj}`) ?? [];
            placed.push([a * x + c * y + e, b * x + d * y + f]);
            corners.set(`${ci},${cj}`, placed);
          }
        });
        expect(corners.size).toBe((columns + 1) * (rows + 1));
        for (const [[x0, y0] = [0, 0], ...rest] of corners.values())
          for (const [x, y] of rest) {
            expect(x).toBeCloseTo(x0, 6);
            expect(y).toBeCloseTo(y0, 6);
          }
        // It shrinks as it balls up.
        const size = seen(facets);
        expect(size).toBeLessThan(previous);
        previous = size;
      }
      // Balled up, it is a fraction of the sheet, creased into facets that
      // face the light at different angles.
      expect(previous).toBeLessThan(0.3 * width * height);
      const lights = paperFacets(kind, width, height, { crumple: 1, lift: 1, step: 40 }).map(
        ({ light }) => light,
      );
      expect(Math.max(...lights) - Math.min(...lights)).toBeGreaterThan(0.5);
    },
  );

  it('peels a page grab off the viewport into a card before the slap', () => {
    for (const index of hands) {
      const layout = layoutFor('page', index);
      const start = scrapAt(layout, 0);
      expect(start.visible).toBe(true);
      expect(start.sx * 168).toBeCloseTo(layout.sheet.width, 6);
      const slapped = scrapAt(layout, PRE + layout.hand.beats.slam);
      expect(slapped).toMatchObject({ ...layout.word, sx: 1, sy: 1 });
      expect(layout.patches).toHaveLength(0);
    }
  });

  it('covers each taken line, not the whole bounding box', () => {
    const lines = [
      { x: 125, y: 205, width: 190, height: 20 },
      { x: 125, y: 230, width: 240, height: 20 },
    ];
    const layout = graveLayout({
      kind: 'text',
      source: { x: 125, y: 205, width: 240, height: 45 },
      rectangles: lines,
      viewport: { width: 800, height: 600 },
      text: 'Two lines',
    });
    expect(layout.patches).toEqual(
      lines.map((line) => ({
        x: line.x - 2,
        y: line.y - 1,
        width: line.width + 4,
        height: line.height + 2,
      })),
    );
  });

  it('keeps the cracks around the hole and inside their canvas', () => {
    for (const index of hands) {
      const layout = layoutFor('text', index);
      const box = layout.crackBox;
      for (const [x, y] of layout.cracks.flat()) {
        expect(x).toBeGreaterThanOrEqual(box.x);
        expect(x).toBeLessThanOrEqual(box.x + box.width);
        expect(y).toBeGreaterThanOrEqual(box.y);
        expect(y).toBeLessThanOrEqual(box.y + box.height);
        expect(Math.hypot(x - layout.hole.x, y - layout.hole.y)).toBeLessThan(layout.hole.r * 4);
      }
    }
  });

  it('fades any pose out completely', () => {
    const layout = layoutFor('page');
    const from = poseAt(layout, { phase: 'grab', t: 400 });
    expect(poseAt(layout, { phase: 'fade', u: GRAVE_DURATION.fade, from }).opacity).toBe(0);
  });

  it('reads dark pages as dark, for the crack highlights and dust', () => {
    const dark = graveLayout({
      kind: 'text',
      source: passage,
      viewport: { width: 1280, height: 800 },
      text: 'Night mode',
      style: { fontFamily: 'serif', color: 'rgb(216, 219, 226)', background: 'rgb(22, 24, 29)' },
    });
    expect(dark.dark).toBe(true);
    expect(layoutFor('text').dark).toBe(false);
  });

  it('lifts only the torn rim on dark pages, so it shows around the black hole', () => {
    const hand = GRAVE_HANDS[0];
    if (!hand) throw new Error('No hand');
    const { width, height } = hand.size;
    // The lift `radii` hole radii to the right of the hole's centre, in a frame `shrink` times smaller.
    const at = (lift: Float32Array | null, radii: number, shrink = 1) => {
      const x = Math.floor((hand.hole.x + radii * hand.hole.radius) / shrink);
      return lift?.[Math.floor(hand.hole.y / shrink) * (width / shrink) + x] ?? 0;
    };
    // A light page's wall is multiplied by the page's own colour, as before.
    expect(rimLift([255, 255, 255], hand, width, height)).toBeNull();
    expect(rimLift([110, 110, 110], hand, width, height)).toBeNull();
    // No step where pages start counting as dark.
    const edge = 0.4 * 255 - 0.5;
    expect(at(rimLift([edge, edge, edge], hand, width, height), 1.3)).toBeLessThan(0.01);
    // On a near-black page the rim, which lies between 0.9 and 2.2 hole radii in every
    // take, is lifted; the black core and the wall beyond, with its dust, are not.
    const lift = rimLift([27, 27, 27], hand, width, height);
    const page = 27 / 255;
    expect(at(lift, 0.5)).toBe(0);
    expect(at(lift, 2.5)).toBe(0);
    // The footage's grey rim (about half its white) comes out clearly lighter than the
    // page, where unlifted it would sink below it; grey dust beyond stays below it.
    expect(tintChannel(128, page, at(lift, 1.3))).toBeGreaterThan(27 + 15);
    expect(tintChannel(128, page, at(lift, 2.5))).toBeLessThan(27);
    // Frames decoded smaller get the same ring.
    const smaller = rimLift([27, 27, 27], hand, width / 2, height / 2);
    expect(at(smaller, 1.3, 2)).toBeCloseTo(at(lift, 1.3), 2);
    expect(at(smaller, 2.5, 2)).toBe(0);
  });
});
