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
