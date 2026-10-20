import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buryDuration,
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
  scrapAt,
  splitFrames,
} from '../../src/ui/grave';
import { GRAVE_HANDS } from '../../src/ui/grave-sprite';

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
      // Every frame carries alpha at the declared size.
      expect((header[20] ?? 0) & 0x10).toBe(0x10);
      expect(1 + header.readUIntLE(24, 3)).toBe(hand.size.width);
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
    expect(duration).toBeLessThan(2_400);
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
    const { take } = layout.hand.beats;
    expect(scrapAt(layout, PRE + take - 1).visible).toBe(false);
    expect(scrapAt(layout, PRE + take)).toMatchObject({ visible: true, ...layout.word });
    const held = scrapAt(layout, PRE + take + 4);
    const grip = layout.hand.grip[take + 4];
    if (!grip) throw new Error('No grip');
    expect(held.x).toBeCloseTo(onPage(layout, grip).x - 21 * layout.scale, 6);
    expect(held.y).toBeCloseTo(onPage(layout, grip).y, 6);
    expect(held.sx).toBeLessThan(1);
  });

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
});
