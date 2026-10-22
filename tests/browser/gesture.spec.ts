import { test, expect } from '@playwright/test';
import {
  configureVault,
  captureAt,
  drawCircle,
  launchExtension,
  openPopup,
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
      // The passage fills its paragraph, so it carries no paragraph of context.
      context: { heading: 'The curious field journal.' },
      passageUrl: `${article.url()}#:~:text=A%20young%20dog%20runs,a%20bright%20tennis%20ball.`,
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

test('the lasso takes a sentence from text set in plain divs and spans, as search results are', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault, false);
    const results = `${vault.origin}/results`;
    await fixture.context.route(results, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>camera bundles - Search</title>
          <style>body { font: 16px/24px sans-serif; margin: 40px } .row { display: flex; gap: 8px }</style>
          <div id="results" style="min-height: 1400px"><div class="result">
            <a href="https://shop.example/bundles"><h3>Camera bundles - Example shop</h3></a>
            <div class="row"><span id="address">https://shop.example › bundles</span></div>
            <div id="snippet"><span>Explore the camera bundles at the first local store. Free shipping on <em>most</em> orders.</span></div>
          </div><div>More results from shop.example</div></div>`,
      }),
    );
    const page = await fixture.context.newPage();
    await page.goto(results);
    await wake(fixture, page);
    const words = await page.locator('#snippet span').boundingBox();
    const address = await page.locator('#address').boundingBox();
    if (!words || !address) throw new Error('Missing result');
    // Far below the results and well right of a line's end, Chrome still puts
    // its caret in the nearest words, lines with no full stop to end them, yet
    // the hand slips: nothing is recorded over the seconds a grab would take.
    for (const away of [
      { x: 300, y: 700 },
      { x: address.x + address.width + 300, y: address.y + address.height / 2 },
    ]) {
      await drawCircle(page, away, 'Shift');
      for (let waited = 0; waited < 2_500; waited += 250) {
        expect(await state(fixture)).toHaveLength(0);
        await page.waitForTimeout(250);
      }
    }
    await drawCircle(page, { x: words.x + 60, y: words.y + 12 }, 'Shift');
    await expect.poll(async () => (await state(fixture))[0]?.persistence).toBe('saved-vault');
    const captures = await state(fixture);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.candidate).toMatchObject({
      kind: 'text',
      url: results,
      text: 'Explore the camera bundles at the first local store.',
    });
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
    // The toolbar popup's switch turns the hand on everywhere.
    const turnOn = await openPopup(fixture, first);
    await turnOn.evaluate('document.getElementById("activation").click()');
    await expect
      .poll(() => turnOn.evaluate<string>('document.getElementById("mode").textContent'))
      .toBe('On everywhere');
    await turnOn.close();
    // The settings page, opened before, reads the switch when it loads.
    await fixture.options.reload();
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
    const pause = await openPopup(fixture, reopened);
    expect(await pause.evaluate<string>('document.getElementById("activation").textContent')).toBe(
      'Pause everywhere',
    );
    await pause.evaluate('document.getElementById("activation").click()');
    await expect
      .poll(() => pause.evaluate<string>('document.getElementById("mode").textContent'))
      .toBe('Paused');
    // Paused means paused: the popup offers no grab until the hand is turned on again.
    expect(
      await pause.evaluate<boolean[]>(
        '["grab-selection", "grab-page"].map((id) => document.getElementById(id).disabled)',
      ),
    ).toEqual([true, true]);
    await pause.close();
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

test('reloading the extension leaves one working hand on a page that was already open', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full', true, true);
  try {
    await configureVault(fixture, vault, false);
    const page = await fixture.context.newPage();
    await page.goto(`${vault.origin}/article`);
    await fixture.options.bringToFront();
    await fixture.options.getByRole('button', { name: 'Enable across tabs', exact: true }).click();
    await expect(fixture.options.locator('#activation-state')).toContainText(
      'On across your browser',
    );
    await page.bringToFront();
    await expect(page.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    const original = await page.locator('[data-zombie-hand-ui]').elementHandle();
    if (!original) throw new Error('No hand');
    // As after a rebuild and Reload in chrome://extensions: the page keeps the
    // old content script, cut off from the extension, and is given a new one.
    const browser = fixture.context.browser();
    if (!browser) throw new Error('No browser');
    const session = await browser.newBrowserCDPSession();
    const restarted = fixture.context.waitForEvent('serviceworker');
    try {
      // What Reload in chrome://extensions does to an unpacked extension.
      await session.send('Extensions.loadUnpacked', { path: fixture.extension });
    } finally {
      await session.detach();
    }
    await restarted;
    // Before anything is touched, the new copy has replaced the old hand.
    await expect.poll(() => original.evaluate((node) => node.isConnected)).toBe(false);
    await expect(page.locator('[data-zombie-hand-ui]')).toHaveCount(1);
    const options = await fixture.context.newPage();
    await options.goto(`chrome-extension://${fixture.id}/options.html`);
    await page.bringToFront();
    await captureAt(page, '#dog', 'circle');
    await expect
      .poll(async () => {
        const response = (await options.evaluate(() =>
          chrome.runtime.sendMessage({ v: 1, type: 'GET_STATE' }),
        )) as { captures?: { persistence: string }[] };
        return response.captures?.map((capture) => capture.persistence);
      })
      .toEqual(['saved-vault']);
    await expect(page.locator('[data-zombie-hand-ui]')).toHaveCount(1);
  } finally {
    await fixture.close();
    await vault.close();
  }
});
