import { expect, test, type Page } from '@playwright/test';
import type { AppResponse } from '../../src/core/contracts/index';
import {
  captureAt,
  launchExtension,
  openPopup,
  state,
  wake,
  type ExtensionFixture,
} from './helpers/extension-fixture';
import { startVaultFixture, type VaultFixture } from './helpers/vault-fixture';

const notConnected =
  'Not connected. Paste the API key from Obsidian → Settings → Local REST API, then save.';
const connected = (vault: VaultFixture) =>
  `Connected to ${vault.origin}. Grabs save to the “Zombie Hand” folder.`;
const notRemembered =
  'This key is kept only until Chrome closes or the extension reloads. Tick “Remember the key on this browser profile” and save to keep it.';
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/** Fills the vault form as a person does. Nothing is pressed. */
async function fillVault(
  fixture: ExtensionFixture,
  vault: VaultFixture,
  { key = vault.key, remember = false } = {},
): Promise<void> {
  const options = fixture.options;
  await options.locator('#endpoint').fill(vault.origin);
  await options.locator('#allow-http').check();
  await options.locator('#api-key').fill(key);
  await options.locator('#remember-key').setChecked(remember);
  // The local model and ghosts play no part here.
  await options.locator('#feature-semantic').uncheck();
  await options.locator('#feature-haunting').uncheck();
}

async function save(fixture: ExtensionFixture): Promise<void> {
  await fixture.options.getByRole('button', { name: /^Save settings/ }).click();
}

async function scrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);
}

/** The element's whole box lies inside the viewport. */
async function whollyOnScreen(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error(`${selector} has no box on screen`);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test('pasting a key and pressing Save alone connects the vault and syncs the grab that was waiting', async () => {
  test.setTimeout(90_000);
  // Slow writes keep the vault test on screen long enough to see it.
  const vault = await startVaultFixture({ writeDelayMs: 500 });
  const fixture = await launchExtension('full');
  try {
    // A grab made before any vault is connected waits on this device.
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await wake(fixture, article);
    await captureAt(article, '#dog');
    await expect
      .poll(async () => (await state(fixture)).map((capture) => capture.persistence))
      .toEqual(['failed']);

    const options = fixture.options;
    await options.bringToFront();
    await options.reload();
    await expect(options.locator('#vault-state')).toHaveText(notConnected);
    await expect(options.locator('#api-key')).toHaveAttribute(
      'placeholder',
      'Paste the key from your local plugin',
    );
    await fillVault(fixture, vault);
    await scrollTo(options, 1e6);
    await save(fixture);

    // It tests the vault unasked, saying so beside Save and wherever the page is scrolled.
    await expect(options.locator('#vault-state')).toHaveText('Testing the vault…');
    await expect(options.locator('#message')).toContainText('Settings saved. Testing');
    await whollyOnScreen(options, '#message');
    await expect(options.locator('#vault-status')).toBeInViewport({ ratio: 1 });
    await expect(options.locator('#vault-state')).toHaveText(startsWith(connected(vault)), {
      timeout: 30_000,
    });
    await expect(options.locator('#message')).toContainText('binary roundtrip verified');
    await whollyOnScreen(options, '#message');
    await expect(options.locator('#vault-status')).toBeInViewport({ ratio: 1 });
    for (const top of [0, 1e6]) {
      await scrollTo(options, top);
      await whollyOnScreen(options, '#message');
    }

    // The waiting grab reaches the vault, and the status follows the queue down.
    await expect
      .poll(async () => (await state(fixture)).map((capture) => capture.persistence), {
        timeout: 30_000,
      })
      .toEqual(['saved-vault']);
    const [capture] = await state(fixture);
    expect(vault.files.get(`Zombie Hand/captures/${capture?.id}.md`)?.toString()).toContain(
      'young dog',
    );
    await expect(options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 15_000,
    });

    // The field says a key is held, and never shows it.
    await expect(options.locator('#api-key')).toHaveValue('');
    await expect(options.locator('#api-key')).toHaveAttribute(
      'placeholder',
      'Key saved. Paste a new key to replace it.',
    );
    await expect(options.locator('#key-state')).toHaveText(
      'A vault key is stored. Leave the field blank to keep it.',
    );
    expect(await options.content()).not.toContain(vault.key);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('a key the vault refuses stays saved, says why beside Save, and the popup claims no connection', async () => {
  test.setTimeout(90_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    const refused = 'Vault access was denied. Check the API key and permission.';
    const paused = `The key is saved, but grabs are not syncing yet. The last vault test failed: ${refused}`;
    await fillVault(fixture, vault, { key: 'synthetic-wrong-key-not-a-secret' });
    await scrollTo(options, 1e6);
    await save(fixture);
    await expect(options.locator('#vault-state')).toHaveText(paused, { timeout: 30_000 });
    await expect(options.locator('#message')).toHaveText(refused);
    await expect(options.locator('#message')).toHaveClass(/\berror\b/);
    await whollyOnScreen(options, '#message');
    await expect(options.locator('#vault-status')).toBeInViewport({ ratio: 1 });

    // The settings are kept and sync stays paused, so nothing was written to the vault.
    const saved = await options.evaluate(
      () => chrome.runtime.sendMessage({ v: 1, type: 'GET_STATE' }) as Promise<AppResponse>,
    );
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.settings?.endpoint).toBe(vault.origin);
    expect(saved.vaultStatus).toEqual({ state: 'paused', remembered: false, error: refused });
    expect(vault.requests.length).toBeGreaterThan(0);
    expect(vault.requests.every((request) => !request.authorized)).toBe(true);
    expect(vault.files.size).toBe(0);
    await options.reload();
    await expect(options.locator('#vault-state')).toHaveText(paused);
    await expect(options.locator('#endpoint')).toHaveValue(vault.origin);

    // The popup says the key is saved but not syncing, and leads to the test.
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    let popup = await openPopup(fixture, article);
    expect(await popup.evaluate<string>('document.getElementById("vault").textContent')).toBe(
      'Vault key saved, but not syncing yet. Test vault',
    );
    expect(
      await popup.evaluate<string>('document.querySelector("#vault a").getAttribute("href")'),
    ).toBe('options.html');
    await popup.close();

    // Test stays the retry: with the right key it connects, and the popup says so.
    await options.bringToFront();
    await options.locator('#api-key').fill(vault.key);
    await options.locator('#connect').click();
    await expect(options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });
    popup = await openPopup(fixture, article);
    expect(await popup.evaluate<string>('document.getElementById("vault").textContent')).toBe(
      'Vault connected. Grabs are buried in Obsidian.',
    );
    await popup.close();
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('a key not remembered is said to last until Chrome closes, and remembering it keeps it', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await expect(fixture.options.locator('#vault-remember')).toBeHidden();
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(fixture.options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });
    await expect(fixture.options.locator('#vault-remember')).toBeVisible();
    await expect(fixture.options.locator('#vault-remember')).toHaveText(notRemembered);

    // As it says, a restart loses the key.
    await fixture.restart();
    await expect(fixture.options.locator('#vault-state')).toHaveText(notConnected);
    await expect(fixture.options.locator('#vault-remember')).toBeHidden();

    // Ticking Remember and saving keeps the key, and the line goes.
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(fixture.options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });
    await expect(fixture.options.locator('#vault-remember')).toBeVisible();
    await fixture.options.locator('#remember-key').check();
    await save(fixture);
    await expect(fixture.options.locator('#message')).toHaveText('Settings saved.');
    await expect(fixture.options.locator('#vault-remember')).toBeHidden();
    await expect(fixture.options.locator('#vault-state')).toHaveText(connected(vault));
    await fixture.restart();
    await expect(fixture.options.locator('#vault-state')).toHaveText(connected(vault));
    await expect(fixture.options.locator('#vault-remember')).toBeHidden();
  } finally {
    await fixture.close();
    await vault.close();
  }
});

/** The vault test's words when the vault cannot be reached. */
const unreachable =
  'The vault could not be read. Check its connection, certificate and permission.';
/** The orange dot of a warning, as ui.css paints it. */
const warningDot = 'rgb(255, 197, 140)';
const dotColour = (page: Page) =>
  page
    .locator('#vault-status')
    .evaluate((box) => getComputedStyle(box, '::before').backgroundColor);
const popupLine = (popup: Awaited<ReturnType<typeof openPopup>>) =>
  popup.evaluate<string>('document.getElementById("vault").textContent');

test('a vault test that fails while syncing says so beside Save and in the popup, never Connected', async () => {
  test.setTimeout(90_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  let vaultOpen = true;
  try {
    const options = fixture.options;
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });
    // The fixture serves the article too, so it is open before the vault goes away.
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await vault.close();
    vaultOpen = false;

    await options.bringToFront();
    await options.locator('#connect').click();
    await expect(options.locator('#message')).toHaveText(unreachable, { timeout: 30_000 });
    await expect(options.locator('#vault-state')).toHaveText(
      `Sync is on for ${vault.origin}, but the last vault test failed: ${unreachable}`,
    );
    await expect(options.locator('#vault-status')).toHaveAttribute('data-state', 'failing');
    expect(await dotColour(options)).toBe(warningDot);

    const popup = await openPopup(fixture, article);
    expect(await popupLine(popup)).toBe('The last vault test failed. Test vault');
    expect(
      await popup.evaluate<string>('document.querySelector("#vault a").getAttribute("href")'),
    ).toBe('options.html');
    await popup.close();
  } finally {
    await fixture.close();
    if (vaultOpen) await vault.close();
  }
});

test('with Chrome’s access to the vault turned off the status says so, and Save turns it back on', async () => {
  test.setTimeout(90_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });

    // A person turns site access to "On click" in chrome://extensions. The test copy's
    // loopback grant is a required permission, which chrome.permissions.remove refuses,
    // so the test makes the same call that page makes.
    const manager = await fixture.context.newPage();
    await manager.goto(`chrome://extensions/?id=${fixture.id}`);
    const siteAccess = (hostAccess: 'ON_CLICK' | 'ON_ALL_SITES') =>
      manager.evaluate(
        ([extensionId, access]) =>
          (
            chrome as unknown as {
              developerPrivate: {
                updateExtensionConfiguration(update: object): Promise<void>;
              };
            }
          ).developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: access }),
        [fixture.id, hostAccess] as const,
      );
    const endpointAccess = () =>
      options.evaluate(
        (pattern) => chrome.permissions.contains({ origins: [pattern] }),
        'http://127.0.0.1/*',
      );
    await siteAccess('ON_CLICK');
    expect(await endpointAccess()).toBe(false);

    await options.bringToFront();
    await options.reload();
    await expect(options.locator('#vault-state')).toHaveText(
      `The key is saved, but grabs can’t sync: Chrome’s access to ${vault.origin} is off. Press Save settings to grant it.`,
    );
    const state = await options.evaluate(
      () => chrome.runtime.sendMessage({ v: 1, type: 'GET_STATE' }) as Promise<AppResponse>,
    );
    if (!state.ok) throw new Error(state.error);
    expect(state.vaultStatus).toEqual({ state: 'paused', remembered: false, access: false });

    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    const popup = await openPopup(fixture, article);
    expect(await popupLine(popup)).toBe('Vault key saved, but not syncing yet. Test vault');
    await popup.close();

    // Chrome's prompt cannot be answered headless, so the page's request is answered
    // as a person accepting it would: the access comes back, and Chrome then grants it.
    await options.bringToFront();
    await options.exposeFunction('acceptSiteAccess', () => siteAccess('ON_ALL_SITES'));
    await options.evaluate(() => {
      const permissions = chrome.permissions as unknown as {
        request(permissions: chrome.permissions.Permissions): Promise<boolean>;
      };
      const request = permissions.request.bind(permissions);
      permissions.request = async (wanted) => {
        await (window as unknown as { acceptSiteAccess(): Promise<void> }).acceptSiteAccess();
        return request(wanted);
      };
    });
    await save(fixture);
    await expect(options.locator('#vault-state')).toHaveText(connected(vault));
    await expect(options.locator('#message')).toHaveText('Settings saved.');
    expect(await endpointAccess()).toBe(true);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('at phone width the toast goes after its time and the page end scrolls clear of it', async () => {
  test.setTimeout(120_000);
  // Slow writes keep the first notice up long enough to be replaced well into its time.
  const vault = await startVaultFixture({ writeDelayMs: 700 });
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    const toast = options.locator('#message');
    await options.setViewportSize({ width: 390, height: 844 });
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(toast).toContainText('Settings saved. Testing');
    const firstShown = Date.now();
    await expect(toast).toContainText('binary roundtrip verified', { timeout: 30_000 });
    const resultShown = Date.now();
    expect(resultShown - firstShown).toBeGreaterThan(2_000);

    // The longest notice this page shows, at its narrowest: the page end clears it.
    await scrollTo(options, 1e6);
    const footer = await options.locator('footer').boundingBox();
    const shown = await toast.boundingBox();
    if (!footer || !shown) throw new Error('No footer or toast on screen');
    expect(footer.y + footer.height).toBeLessThanOrEqual(shown.y);
    await whollyOnScreen(options, '#message');

    // A new notice restarts the clock: the result outlives six seconds from the first.
    await options.waitForTimeout(Math.max(0, firstShown + 6_500 - Date.now()));
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: Math.max(1, resultShown + 7_000 - Date.now()) });

    // An error stays for 15 seconds.
    await options.locator('#endpoint').fill('https://example.com');
    await save(fixture);
    await expect(toast).toHaveText(
      'Use the numeric loopback API endpoint, such as https://127.0.0.1:27124',
    );
    await expect(toast).toHaveClass(/\berror\b/);
    const errorShown = Date.now();
    await options.waitForTimeout(8_000);
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: Math.max(1, errorShown + 16_000 - Date.now()) });
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('the status stops re-reading once the waiting count holds still, and reads again on return or Save', async () => {
  test.setTimeout(150_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  let vaultOpen = true;
  try {
    const options = fixture.options;
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });
    // Sync stays on, but the vault has gone, so the grab waits.
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await wake(fixture, article);
    await vault.close();
    vaultOpen = false;
    await captureAt(article, '#dog');
    await expect.poll(async () => (await state(fixture)).length).toBe(1);

    await options.bringToFront();
    await options.reload();
    await expect(options.locator('#vault-state')).toHaveText(
      `${connected(vault)} 1 capture waiting to sync.`,
    );
    // Count the page's reads of the background state from here on.
    await options.evaluate(() => {
      const page = window as unknown as { reads: number };
      page.reads = 0;
      const runtime = chrome.runtime as unknown as { sendMessage(message: unknown): unknown };
      const send = runtime.sendMessage.bind(runtime);
      runtime.sendMessage = (message) => {
        if ((message as { type?: string })?.type === 'GET_STATE') page.reads += 1;
        return send(message);
      };
    });
    const reads = () => options.evaluate(() => (window as unknown as { reads: number }).reads);
    /** Waits out three refresh periods and returns the reads, which must have stopped. */
    async function settledReads(): Promise<number> {
      await options.waitForTimeout(13_000);
      const settled = await reads();
      await options.waitForTimeout(9_000);
      expect(await reads()).toBe(settled);
      return settled;
    }
    const first = await settledReads();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(3);

    // Coming back to the tab reads it again, and the reads stop again.
    await options.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const back = await settledReads();
    expect(back - first).toBeGreaterThanOrEqual(2);
    expect(back - first).toBeLessThanOrEqual(4);

    // So does a Save.
    await save(fixture);
    await expect(options.locator('#message')).toHaveText('Settings saved.');
    const saved = await settledReads();
    expect(saved - back).toBeGreaterThanOrEqual(2);
    expect(saved - back).toBeLessThanOrEqual(5);
    await expect(options.locator('#vault-state')).toHaveText(
      `${connected(vault)} 1 capture waiting to sync.`,
    );

    // And so does a Test, which fails with the vault gone and says so.
    await options.locator('#connect').click();
    await expect(options.locator('#message')).toHaveText(unreachable, { timeout: 30_000 });
    const tested = await settledReads();
    expect(tested - saved).toBeGreaterThanOrEqual(4);
    expect(tested - saved).toBeLessThanOrEqual(6);
    await expect(options.locator('#vault-state')).toHaveText(
      `Sync is on for ${vault.origin}, but the last vault test failed: ${unreachable} 1 capture waiting to sync.`,
    );
  } finally {
    await fixture.close();
    if (vaultOpen) await vault.close();
  }
});
