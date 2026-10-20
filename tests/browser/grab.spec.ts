import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  configureVault,
  isolatedMessage,
  launchExtension,
  openPopup,
  state,
  wake,
} from './helpers/extension-fixture';
import { startVaultFixture } from './helpers/vault-fixture';

/** A trusted mouse drag across part of a passage; returns the selected words. */
async function dragSelect(page: Page, selector: string): Promise<string> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing ${selector}`);
  const y = box.y + Math.min(box.height / 2, 14);
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => (getSelection()?.toString() ?? '').replace(/\s+/gu, ' ').trim());
}

async function frame(page: Page, name: string, shot?: Buffer): Promise<void> {
  const directory = resolve('.cache/browser-artifacts');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  if (shot) await writeFile(path, shot);
  else await page.screenshot({ path });
}

/**
 * Counts pixels of one colour in a screenshot region: rotting skin (not page
 * ink, paper, plaster or the selection), or the page's blue selection highlight.
 */
async function pixels(
  decoder: Page,
  shot: Buffer,
  region: { x: number; y: number; width: number; height: number },
  colour: 'skin' | 'selection' = 'skin',
): Promise<number> {
  return decoder.evaluate(
    async ({ bytes, area, wanted }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No 2D context');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(area.x, area.y, area.width, area.height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r = 0, g = 0, b = 0] = [data[i], data[i + 1], data[i + 2]];
        const luma = 0.3 * r + 0.59 * g + 0.11 * b;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        // Warm grey skin: plaster debris and cracks are near neutral, the selection is blue.
        const skin = luma > 25 && luma < 200 && chroma >= 12 && r >= g + 5 && b <= g;
        const selection = b - r > 25 && b > 120;
        if (wanted === 'skin' ? skin : selection) count += 1;
      }
      return count;
    },
    { bytes: [...shot], area: region, wanted: colour },
  );
}

type Area = { x: number; y: number; width: number; height: number };

/** The size of what the overlay paints over a page: every pixel that changed between two shots. */
async function painted(decoder: Page, before: Buffer, after: Buffer): Promise<Area | null> {
  return decoder.evaluate(
    async ({ first, second }) => {
      const read = async (bytes: number[]) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D context');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [a, b] = [await read(first), await read(second)];
      let [left, top, right, bottom] = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < a.height; y += 1)
        for (let x = 0; x < a.width; x += 1) {
          const i = (y * a.width + x) * 4;
          const change = Math.max(
            Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)),
            Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)),
            Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)),
          );
          if (change <= 24) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      return right < 0
        ? null
        : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
    },
    { first: [...before], second: [...after] },
  );
}

/** The live selection's bounds, and the area the browser paints it over (whole line boxes). */
async function selectionArea(page: Page): Promise<{ bounds: Area; painted: Area }> {
  const bounds = await page.evaluate(() => {
    const rectangle = getSelection()?.getRangeAt(0).getBoundingClientRect();
    return rectangle
      ? { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height }
      : null;
  });
  if (!bounds) throw new Error('No selection rectangle');
  const painted = {
    x: Math.round(bounds.x - 8),
    y: Math.round(bounds.y - 10),
    width: Math.round(bounds.width + 16),
    height: Math.round(bounds.height + 20),
  };
  return { bounds, painted };
}

/**
 * Clicks the corner hand and films the grab for three seconds, clipped to
 * `clip`: the hand is picked at random, and each reaches the words at its own
 * pace. Decoding waits until filming ends, because opening a tab earlier would
 * take focus from the page and cancel the grab.
 */
async function filmGrab(
  fixture: Awaited<ReturnType<typeof launchExtension>>,
  page: Page,
  clip: Area,
): Promise<{
  before: Buffer;
  shots: Buffer[];
  count: (shot: Buffer, area: Area, colour?: 'skin' | 'selection') => Promise<number>;
}> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('No viewport');
  const before = await page.screenshot({ clip });
  await page.mouse.click(viewport.width - 35, viewport.height - 35);
  const clicked = Date.now();
  const shots: Buffer[] = [];
  while (Date.now() - clicked < 3_000) shots.push(await page.screenshot({ clip }));
  const decoder = await fixture.context.newPage();
  return {
    before,
    shots,
    count: (shot, area, colour) =>
      pixels(decoder, shot, { ...area, x: area.x - clip.x, y: area.y - clip.y }, colour),
  };
}

test('the footage hand bursts through a page whose CSP forbids every image', async () => {
  test.setTimeout(60_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const strict = await fixture.context.newPage();
    await strict.goto(`${vault.origin}/strict`);
    await wake(fixture, strict);
    const words = await dragSelect(strict, '#strict');
    const { bounds, painted } = await selectionArea(strict);
    // The grave tears open just below the passage and the hand climbs out over it.
    const region = {
      x: Math.round(bounds.x + bounds.width / 2 - 90),
      y: Math.round(bounds.y + bounds.height - 150),
      width: 180,
      height: 200,
    };
    // One clip covers both, so each frame is quick to capture and decode.
    const clip = {
      x: Math.min(region.x, painted.x),
      y: Math.min(region.y, painted.y),
      width:
        Math.max(region.x + region.width, painted.x + painted.width) -
        Math.min(region.x, painted.x),
      height:
        Math.max(region.y + region.height, painted.y + painted.height) -
        Math.min(region.y, painted.y),
    };
    const { before, shots, count } = await filmGrab(fixture, strict, clip);
    const quiet = await count(before, region);
    const highlighted = await count(before, painted, 'selection');
    const haunted: number[] = [];
    const left: number[] = [];
    for (const shot of shots) {
      haunted.push(await count(shot, region));
      left.push(await count(shot, painted, 'selection'));
    }
    const peak = Math.max(...haunted);
    await frame(strict, 'grab-strict-csp', shots[haunted.indexOf(peak)]);
    expect(quiet).toBeLessThan(60);
    // Peaks measured 7,900 to 12,600 across the three hands; cracks and debris alone count zero.
    expect(peak).toBeGreaterThan(3_000);
    // Once the hand has taken the words, none of the page's own highlight is left
    // showing around the blank where they were.
    expect(highlighted).toBeGreaterThan(2_000);
    expect(Math.min(...left)).toBeLessThan(30);
    await expect
      .poll(async () => (await state(fixture)).map((c) => c.candidate.text))
      .toContain(words);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('with no vault connected the hand still climbs out, and the page can open settings', async () => {
  test.setTimeout(60_000);
  // Only the fixture's pages are used: the extension is never told about its vault.
  const pages = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    const strict = await fixture.context.newPage();
    await strict.goto(`${pages.origin}/strict`);
    const tabId = await wake(fixture, strict);
    const words = await dragSelect(strict, '#strict');
    const { bounds } = await selectionArea(strict);
    const region = {
      x: Math.round(bounds.x + bounds.width / 2 - 90),
      y: Math.round(bounds.y + bounds.height - 150),
      width: 180,
      height: 200,
    };
    const { shots, count } = await filmGrab(fixture, strict, region);
    const haunted: number[] = [];
    for (const shot of shots) haunted.push(await count(shot, region));
    const peak = Math.max(...haunted);
    await frame(strict, 'grab-no-vault', shots[haunted.indexOf(peak)]);
    // Without a vault the capture fails over at once; the hand must not let go before it surfaces.
    expect(peak).toBeGreaterThan(3_000);
    await expect
      .poll(async () => (await state(fixture)).map((c) => [c.candidate.text, c.persistence]))
      .toContainEqual([words, 'failed']);
    // The receipt's Settings button sends this from the page in front; Chrome
    // brings up the options page, opening it again once it has been closed.
    await fixture.options.close();
    await strict.bringToFront();
    const [opened, response] = await Promise.all([
      fixture.context.waitForEvent('page', { timeout: 10_000 }),
      isolatedMessage(fixture, tabId, { v: 1, type: 'OPEN_SETTINGS' }),
    ]);
    expect(response.ok).toBe(true);
    expect(opened.url()).toBe(`chrome-extension://${fixture.id}/options.html`);
    // The toolbar popup says where the capture is and how to finish burying it.
    const popup = await openPopup(fixture, strict);
    expect(await popup.evaluate<string>('document.getElementById("vault").textContent')).toBe(
      'No vault yet; 1 capture is kept on this device. Connect vault',
    );
    expect(
      await popup.evaluate<string>('document.querySelector("#vault a").getAttribute("href")'),
    ).toBe('options.html');
    await popup.close();
  } finally {
    await fixture.close();
    await pages.close();
  }
});

for (const shape of ['two paragraphs', 'a translucent callout'] as const)
  test(`taking a selection across ${shape} leaves none of its highlight showing`, async () => {
    test.setTimeout(60_000);
    const vault = await startVaultFixture();
    const fixture = await launchExtension('full');
    try {
      await configureVault(fixture, vault, false);
      const article = await fixture.context.newPage();
      await article.goto(`${vault.origin}/article`);
      // A 4% wash: patches that borrowed it unmixed would let the words show through.
      if (shape === 'a translucent callout')
        await article.addStyleTag({ content: '#dog{background:rgba(0,0,0,0.04)}' });
      await wake(fixture, article);
      if (shape === 'two paragraphs') {
        // The selection's common ancestor is the page's main column, whose line
        // height and size are not the paragraphs'.
        const from = await article.locator('#dog').boundingBox();
        const to = await article.locator('#database').boundingBox();
        if (!from || !to) throw new Error('Missing paragraphs');
        await article.mouse.move(from.x + 1, from.y + 14);
        await article.mouse.down();
        await article.mouse.move(to.x + to.width * 0.5, to.y + 14, { steps: 10 });
        await article.mouse.up();
      } else await dragSelect(article, '#dog');
      const { painted } = await selectionArea(article);
      const { before, shots, count } = await filmGrab(fixture, article, painted);
      const left: number[] = [];
      for (const shot of shots) left.push(await count(shot, painted, 'selection'));
      await frame(
        article,
        `grab-highlight-${shape.replaceAll(' ', '-')}`,
        shots[left.indexOf(Math.min(...left))],
      );
      expect(await count(before, painted, 'selection')).toBeGreaterThan(2_000);
      expect(Math.min(...left)).toBeLessThan(30);
    } finally {
      await fixture.close();
      await vault.close();
    }
  });

test('the toolbar popup grabs the selection or the page and gets out of the way; the page keeps a slim hand', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    const viewport = article.viewportSize();
    if (!viewport) throw new Error('No viewport');
    // The dock's corner, clear of where a grab's paper sheet tumbles.
    const corner = { x: viewport.width - 300, y: viewport.height - 64, width: 300, height: 64 };
    const bare = await article.screenshot({ clip: corner });
    const texts = async (): Promise<string[]> =>
      (await state(fixture)).map((capture) => capture.candidate.text);

    // Nothing selected: the popup says so where the click was, stays open and takes nothing.
    let popup = await openPopup(fixture, article);
    expect(await popup.evaluate<string>('document.getElementById("mode").textContent')).toBe(
      'On request',
    );
    expect(await popup.evaluate<string>('document.getElementById("vault").textContent')).toBe(
      'Vault connected. Grabs are buried in Obsidian.',
    );
    await popup.evaluate('document.getElementById("grab-selection").click()');
    await expect
      .poll(() => popup.evaluate<string>('document.getElementById("message").textContent'))
      .toContain('Select some text on the page first');
    expect(await popup.open()).toBe(true);
    await popup.close();
    expect(await state(fixture)).toHaveLength(0);

    // A selection survives the popup taking focus; Grab selection takes exactly it.
    const words = await dragSelect(article, '#dog');
    expect(words.length).toBeGreaterThan(10);
    popup = await openPopup(fixture, article);
    await popup.evaluate('document.getElementById("grab-selection").click()');
    await expect.poll(() => popup.open()).toBe(false);
    await popup.close();
    await expect.poll(texts).toContain(words);
    expect((await state(fixture))[0]?.candidate.kind).toBe('text');

    // Grab page takes the page, whatever is selected.
    await article.waitForTimeout(6_300);
    popup = await openPopup(fixture, article);
    await popup.evaluate('document.getElementById("grab-page").click()');
    await expect.poll(() => popup.open()).toBe(false);
    await popup.close();
    await expect
      .poll(async () => (await state(fixture)).find((capture) => capture.candidate.kind === 'link'))
      .toMatchObject({ candidate: { url: `${vault.origin}/article` } });
    await expect
      .poll(async () => (await state(fixture)).map((capture) => capture.persistence))
      .toEqual(['saved-vault', 'saved-vault']);

    // On the page, a save is one line beside the hand, then the hand alone.
    const decoder = await fixture.context.newPage();
    await article.bringToFront();
    const saved = await painted(decoder, bare, await article.screenshot({ clip: corner }));
    await frame(article, 'popup-grab-saved');
    // A 42px bar and its soft shadow; the old receipt card stood about 150px tall.
    expect(saved?.height).toBeLessThanOrEqual(50);
    expect(saved?.width).toBeLessThanOrEqual(260);
    await article.waitForTimeout(6_500);
    const quiet = await painted(decoder, bare, await article.screenshot({ clip: corner }));
    expect(quiet?.height).toBeLessThanOrEqual(50);
    expect(quiet?.width).toBeLessThanOrEqual(50);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('one click grabs a selection or the whole page, and a chip follows a settled selection', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await wake(fixture, article);
    const viewport = article.viewportSize();
    if (!viewport) throw new Error('No viewport');
    // The collapsed dock is the bare 36px hand, 14px in from the corner.
    const hand = { x: viewport.width - 35, y: viewport.height - 35 };
    const texts = async (): Promise<string[]> =>
      (await state(fixture)).map((capture) => capture.candidate.text);

    // Hovering reveals the menu beside the hand without moving the hand, and the
    // click does not collapse the page selection it is about to take.
    const first = await dragSelect(article, '#dog');
    expect(first.length).toBeGreaterThan(10);
    await article.mouse.move(hand.x, hand.y, { steps: 4 });
    await article.waitForTimeout(150);
    await article.mouse.click(hand.x, hand.y);
    await article.waitForTimeout(400);
    await frame(article, 'grab-selection-reach');
    await expect.poll(texts).toContain(first);
    expect((await state(fixture))[0]?.candidate.kind).toBe('text');

    // With nothing selected, the same click grabs the page and a readable excerpt.
    await article.evaluate(() => getSelection()?.removeAllRanges());
    await article.waitForTimeout(6_300);
    await article.mouse.move(hand.x, hand.y, { steps: 4 });
    await article.mouse.click(hand.x, hand.y);
    await article.waitForTimeout(500);
    await frame(article, 'grab-page-reach');
    await expect
      .poll(async () => (await state(fixture)).find((capture) => capture.candidate.kind === 'link'))
      .toMatchObject({
        candidate: {
          url: `${vault.origin}/article`,
          text: expect.stringContaining('A young dog runs through the park'),
        },
      });
    const page = (await state(fixture)).find((capture) => capture.candidate.kind === 'link');
    expect(page?.candidate.text).not.toContain('A form field must never be captured');

    // A settled selection grows a chip at its end; one click grabs exactly that.
    const second = await dragSelect(article, '#database');
    await article.waitForTimeout(300);
    await frame(article, 'grab-chip');
    const end = await article.evaluate(() => {
      const rectangles = getSelection()?.getRangeAt(0).getClientRects();
      const last = rectangles?.[rectangles.length - 1];
      return last ? { x: last.right, y: last.bottom } : null;
    });
    if (!end) throw new Error('No selection rectangle');
    await article.mouse.click(end.x + 21, end.y + 19);
    await expect.poll(texts).toContain(second);
    expect(await state(fixture)).toHaveLength(3);
  } finally {
    await fixture.close();
    await vault.close();
  }
});
