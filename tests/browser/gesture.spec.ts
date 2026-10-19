import { test, expect } from '@playwright/test';
import {
  configureVault,
  captureAt,
  drawCircle,
  launchExtension,
  screenshotArtifact,
  state,
  wake,
} from './helpers/extension-fixture';
import { startVaultFixture } from './helpers/vault-fixture';

test('modifier lasso ignores ordinary browsing and captures the highlighted passage with its source', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture({ writeDelayMs: 180 });
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await wake(fixture, article);
    const box = await article.locator('#dog').boundingBox();
    if (!box) throw new Error('Missing passage');
    const center = { x: box.x + 100, y: box.y + 18 };
    await article.mouse.move(center.x, center.y);
    await article.waitForTimeout(1_000);
    await screenshotArtifact(article, 'modifier-idle');
    await drawCircle(article, center, null);
    expect(await state(fixture)).toHaveLength(0);

    await drawCircle(article, center, 'Shift', 0.55);
    await article.waitForTimeout(100);
    expect(await state(fixture)).toHaveLength(0);

    await article.locator('#private-field').focus();
    await drawCircle(article, center, 'Control');
    expect(await state(fixture)).toHaveLength(0);
    await article.locator('#private-field').evaluate((node) => (node as HTMLElement).blur());

    await article.mouse.down();
    await drawCircle(article, center, 'Shift');
    await article.mouse.up();
    await article.evaluate(() => document.getSelection()?.removeAllRanges());
    expect(await state(fixture)).toHaveLength(0);

    // Page scripts cannot forge the deliberate keyboard/pointer input.
    await article.evaluate(({ x, y }) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
      for (let step = 0; step <= 64; step++) {
        const angle = (step / 64) * Math.PI * 2;
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerType: 'mouse',
            clientX: x + Math.cos(angle) * 52,
            clientY: y + Math.sin(angle) * 52,
            shiftKey: true,
          }),
        );
      }
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    }, center);
    expect(await state(fixture)).toHaveLength(0);

    await drawCircle(article, center, 'Control');
    await article.waitForTimeout(200);
    await screenshotArtifact(article, 'modifier-grave-reach');
    await expect.poll(async () => (await state(fixture))[0]?.persistence).toBe('saved-vault');
    const [capture] = await state(fixture);
    expect(capture?.candidate).toEqual({
      kind: 'text',
      url: article.url(),
      title: 'The curious field journal',
      text: 'A young dog runs through the park chasing a bright tennis ball.',
    });
    expect(await article.locator('#dog').textContent()).toBe(capture?.candidate.text);
    expect(vault.files.get(`Zombie Hand/captures/${capture?.id}.md`)?.toString()).toContain(
      article.url(),
    );
    await article.waitForTimeout(1_800);
    await screenshotArtifact(article, 'modifier-saved');
    await drawCircle(article, center, null);
    expect(await state(fixture)).toHaveLength(1);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('universal activation follows tabs, navigation and restart, respects exclusions, and pauses everywhere', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full', true, true);
  try {
    await configureVault(fixture, vault, false);
    const first = await fixture.context.newPage();
    await first.goto(`${vault.origin}/article`);
    expect(await first.locator('[data-zombie-hand-ui]').count()).toBe(0);
    await fixture.options.bringToFront();
    await fixture.options.getByRole('button', { name: 'Enable across tabs', exact: true }).click();
    await expect(fixture.options.locator('#activation-state')).toContainText(
      'On across your browser',
    );
    await first.bringToFront();
    await expect(first.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    const second = await fixture.context.newPage();
    await second.goto(`${vault.origin}/article?second`);
    await expect(second.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    await captureAt(second, '#fern', 'circle');
    await expect
      .poll(
        async () =>
          (await state(fixture)).find((capture) => capture.candidate.kind === 'image')?.persistence,
      )
      .toBe('saved-vault');
    expect(
      (await state(fixture)).find((capture) => capture.candidate.kind === 'image')?.preservation,
    ).toBe('screenshot');
    await first.bringToFront();
    await expect(first.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    await first.reload();
    await expect(first.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    await captureAt(first, '#dog', 'circle');
    await expect
      .poll(
        async () =>
          (await state(fixture)).find((capture) => capture.candidate.kind === 'text')?.persistence,
      )
      .toBe('saved-vault');

    await fixture.options.bringToFront();
    await fixture.options.locator('#excluded').fill('https://blocked.example.org');
    await fixture.options.getByRole('button', { name: /^Save settings/ }).click();
    await expect(fixture.options.locator('#message')).toContainText('Settings saved');
    await fixture.context.route('https://blocked.example.org/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><p>This origin is explicitly excluded.</p>',
      }),
    );
    const excluded = await fixture.context.newPage();
    await excluded.goto('https://blocked.example.org/article');
    await excluded.waitForTimeout(300);
    expect(await excluded.locator('[data-zombie-hand-ui]').count()).toBe(0);

    await fixture.restart();
    await expect(fixture.options.locator('#activation-state')).toContainText(
      'On across your browser',
    );
    const reopened = await fixture.context.newPage();
    await reopened.goto(`${vault.origin}/article?restarted`);
    await expect(reopened.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    await fixture.options.bringToFront();
    await fixture.options.getByRole('button', { name: 'Pause everywhere', exact: true }).click();
    await expect(fixture.options.locator('#activation-state')).toContainText('Paused everywhere');
    await expect(reopened.locator('[data-zombie-hand-ui]')).toHaveCount(0);
    await reopened.bringToFront();
    await reopened.reload();
    await reopened.waitForTimeout(300);
    expect(await reopened.locator('[data-zombie-hand-ui]').count()).toBe(0);
    expect(await state(fixture)).toHaveLength(2);
  } finally {
    await fixture.close();
    await vault.close();
  }
});
