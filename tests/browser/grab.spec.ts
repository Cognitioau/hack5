import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { configureVault, launchExtension, state, wake } from './helpers/extension-fixture';
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

async function frame(page: Page, name: string): Promise<void> {
  const directory = resolve('.cache/browser-artifacts');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}

/** Counts hand-coloured pixels (rotting skin, not page ink, paper, plaster or the selection) in a screenshot region. */
async function handPixels(
  fixture: Awaited<ReturnType<typeof launchExtension>>,
  shot: Buffer,
  region: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const decoder = await fixture.context.newPage();
  try {
    return await decoder.evaluate(
      async ({ bytes, area }) => {
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
          if (luma > 25 && luma < 200 && chroma >= 12 && r >= g + 5 && b <= g) count += 1;
        }
        return count;
      },
      { bytes: [...shot], area: region },
    );
  } finally {
    await decoder.close();
  }
}

test('the rendered hand bursts through a page whose CSP forbids every image', async () => {
  test.setTimeout(60_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const strict = await fixture.context.newPage();
    await strict.goto(`${vault.origin}/strict`);
    await wake(fixture, strict);
    const viewport = strict.viewportSize();
    if (!viewport) throw new Error('No viewport');
    const words = await dragSelect(strict, '#strict');
    const selected = await strict.evaluate(() => {
      const rectangle = getSelection()?.getRangeAt(0).getBoundingClientRect();
      return rectangle ? { x: rectangle.x + rectangle.width / 2, bottom: rectangle.bottom } : null;
    });
    if (!selected) throw new Error('No selection rectangle');
    // The grave tears open just below the passage and the hand climbs out over it.
    const region = {
      x: Math.round(selected.x - 90),
      y: Math.round(selected.bottom - 150),
      width: 180,
      height: 200,
    };
    const quiet = await handPixels(fixture, await strict.screenshot(), region);
    await strict.mouse.click(viewport.width - 35, viewport.height - 35);
    await strict.waitForTimeout(640);
    const shot = await strict.screenshot();
    await frame(strict, 'grab-strict-csp');
    const haunted = await handPixels(fixture, shot, region);
    expect(quiet).toBeLessThan(60);
    // Measured near 12,500 on this fixture; the cracks and debris alone count zero.
    expect(haunted).toBeGreaterThan(3_000);
    await expect
      .poll(async () => (await state(fixture)).map((c) => c.candidate.text))
      .toContain(words);
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
