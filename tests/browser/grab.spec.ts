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
