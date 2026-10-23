import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
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
const connected = (vault: { origin: string }) =>
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

/**
 * Sets Zombie Hand's site access as a person does in chrome://extensions, through the call
 * that page makes. The test copy's loopback grant is a required permission, which
 * chrome.permissions.remove refuses.
 */
async function siteAccessControl(fixture: ExtensionFixture) {
  const manager = await fixture.context.newPage();
  await manager.goto(`chrome://extensions/?id=${fixture.id}`);
  return (hostAccess: 'ON_CLICK' | 'ON_ALL_SITES') =>
    manager.evaluate(
      ([extensionId, access]) =>
        (
          chrome as unknown as {
            developerPrivate: { updateExtensionConfiguration(update: object): Promise<void> };
          }
        ).developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: access }),
      [fixture.id, hostAccess] as const,
    );
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
    await expect(options.locator('#message')).toHaveText(
      `Settings saved, but the vault test failed: ${refused}`,
    );
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

    // While the failure stands, Save tests the vault again rather than only saving. The
    // failure's notice is still up, so the page's messages show the test was run.
    await options.bringToFront();
    await options.evaluate(() => {
      const page = window as unknown as { sent: string[] };
      page.sent = [];
      const runtime = chrome.runtime as unknown as { sendMessage(message: unknown): unknown };
      const send = runtime.sendMessage.bind(runtime);
      runtime.sendMessage = (message) => {
        page.sent.push(String((message as { type?: unknown })?.type));
        return send(message);
      };
    });
    await save(fixture);
    await expect
      .poll(() => options.evaluate(() => (window as unknown as { sent: string[] }).sent))
      .toEqual(['SAVE_SETTINGS', 'GET_STATE', 'PROBE_VAULT', 'GET_STATE']);
    await expect(options.locator('#message')).toHaveText(
      `Settings saved, but the vault test failed: ${unreachable}`,
    );
    await expect(options.locator('#message')).toHaveClass(/\berror\b/);
    await expect(options.locator('#vault-state')).toHaveText(
      `Sync is on for ${vault.origin}, but the last vault test failed: ${unreachable}`,
    );
  } finally {
    await fixture.close();
    if (vaultOpen) await vault.close();
  }
});

/**
 * A loopback relay in front of the vault fixture. It can stop answering, as a vault that
 * has gone away does, and answer again; the fixture itself closes only once.
 */
async function relayTo(vault: VaultFixture) {
  const port = Number(new URL(vault.origin).port);
  let answering = true;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    if (!answering) {
      client.destroy();
      return;
    }
    const upstream = connect(port, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(socket);
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    answer(on: boolean) {
      answering = on;
      if (!on) for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test('with Chrome’s access to the vault turned off the status says so, and Save turns it back on and sends what waited', async () => {
  test.setTimeout(120_000);
  const vault = await startVaultFixture();
  const relay = await relayTo(vault);
  // The extension reaches the vault through the relay.
  const via = { ...vault, origin: relay.origin };
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    await fillVault(fixture, via);
    await save(fixture);
    await expect(options.locator('#vault-state')).toHaveText(connected(via), {
      timeout: 30_000,
    });

    // Two grabs made while the vault does not answer wait on this device. The engine parks
    // a grab after six failed attempts, and only a passing test sends a parked grab, so the
    // second is parked here as the engine would park it.
    relay.answer(false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    await wake(fixture, article);
    /** Each grab has had its first try and waits: failed, or uncertain for a write cut off. */
    const waitingGrabs = async () =>
      (await state(fixture)).filter((c) => ['failed', 'uncertain'].includes(c.persistence)).length;
    await captureAt(article, '#dog');
    await expect.poll(waitingGrabs).toBe(1);
    // The hand on that page now waits for the first grab's receipt, so the second is made
    // in another tab, at its own address.
    const second = await fixture.context.newPage();
    await second.goto(`${vault.origin}/article?tab=2`);
    await wake(fixture, second);
    await captureAt(second, '#database');
    await expect.poll(waitingGrabs).toBe(2);
    const parked = (await state(fixture)).find((c) =>
      JSON.stringify(c.candidate).includes('Database transactions'),
    );
    if (!parked) throw new Error('The second grab is missing');
    /** Parks the grab's job as the engine does after six failed attempts, and reads it back. */
    const park = (id: string) =>
      fixture.worker.evaluate(async (captureId) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open('zombie-hand-v1', 1);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          const store = () => db.transaction('operations', 'readwrite').objectStore('operations');
          await new Promise<void>((resolve, reject) => {
            const put = store().put({
              captureId,
              attempts: 6,
              nextAttemptAt: Number.MAX_SAFE_INTEGER,
            });
            put.onsuccess = () => resolve();
            put.onerror = () => reject(put.error);
          });
          return await new Promise<unknown>((resolve, reject) => {
            const get = store().get(captureId);
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => reject(get.error);
          });
        } finally {
          db.close();
        }
      }, id);
    expect(await park(parked.id)).toEqual({
      captureId: parked.id,
      attempts: 6,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    });

    // A person turns site access to "On click" in chrome://extensions. The test copy's
    // loopback grant is a required permission, which chrome.permissions.remove refuses,
    // so the test makes the same call that page makes. Losing access also pauses the hand
    // everywhere, so no grab can be made while it is off; the vault answers again.
    const siteAccess = await siteAccessControl(fixture);
    const endpointAccess = () =>
      options.evaluate(
        (pattern) => chrome.permissions.contains({ origins: [pattern] }),
        'http://127.0.0.1/*',
      );
    await siteAccess('ON_CLICK');
    expect(await endpointAccess()).toBe(false);
    relay.answer(true);

    await options.bringToFront();
    await options.reload();
    await expect(options.locator('#vault-state')).toHaveText(
      `The key is saved, but grabs can’t sync: Chrome’s access to ${via.origin} is off. Press Save settings to grant it.`,
    );
    const reply = await options.evaluate(
      () => chrome.runtime.sendMessage({ v: 1, type: 'GET_STATE' }) as Promise<AppResponse>,
    );
    if (!reply.ok) throw new Error(reply.error);
    expect(reply.vaultStatus).toEqual({ state: 'paused', remembered: false, access: false });
    const popup = await openPopup(fixture, article);
    expect(await popupLine(popup)).toBe(
      'Vault key saved, but not syncing yet; 2 captures are kept on this device. Test vault',
    );
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
    // Save tests the vault, and the passing test sends both grabs, the parked one too.
    await expect
      .poll(async () => (await state(fixture)).map((c) => c.persistence), { timeout: 20_000 })
      .toEqual(['saved-vault', 'saved-vault']);
    for (const capture of await state(fixture))
      expect(vault.files.has(`Zombie Hand/captures/${capture.id}.md`)).toBe(true);
    await expect(options.locator('#vault-state')).toHaveText(connected(via), {
      timeout: 15_000,
    });
    await expect(options.locator('#message')).toContainText('binary roundtrip verified');
    expect(await endpointAccess()).toBe(true);
  } finally {
    await fixture.close();
    await relay.close();
    await vault.close();
  }
});

test('at phone width a success goes after its time, info and errors stay until replaced, and the page end scrolls clear of the toast', async () => {
  test.setTimeout(120_000);
  // Slow writes keep the vault test, and its info notice, going past a success's six seconds.
  const vault = await startVaultFixture({ writeDelayMs: 3_500 });
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    const toast = options.locator('#message');
    await options.setViewportSize({ width: 390, height: 844 });
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(toast).toContainText('Settings saved. Testing');

    // Info stays while the test runs, until the result replaces it.
    await options.waitForTimeout(6_500);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Settings saved. Testing');
    await expect(toast).toContainText('binary roundtrip verified', { timeout: 30_000 });
    const resultShown = Date.now();

    // The longest notice this page shows, at its narrowest: the page end clears it.
    await scrollTo(options, 1e6);
    const footer = await options.locator('footer').boundingBox();
    const shown = await toast.boundingBox();
    if (!footer || !shown) throw new Error('No footer or toast on screen');
    expect(footer.y + footer.height).toBeLessThanOrEqual(shown.y);
    await whollyOnScreen(options, '#message');

    // A success goes six seconds after it shows.
    await options.waitForTimeout(Math.max(0, resultShown + 5_000 - Date.now()));
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: Math.max(1, resultShown + 7_000 - Date.now()) });

    // An error stays, past the fifteen seconds it once had, until the next notice.
    await options.locator('#endpoint').fill('https://example.com');
    await save(fixture);
    await expect(toast).toHaveText(
      'Use the numeric loopback API endpoint, such as https://127.0.0.1:27124',
    );
    await expect(toast).toHaveClass(/\berror\b/);
    await options.waitForTimeout(16_000);
    await expect(toast).toBeVisible();
    await options.locator('#endpoint').fill(vault.origin);
    await save(fixture);
    await expect(toast).toHaveText('Settings saved.');
    await expect(toast).toHaveClass(/\bsuccess\b/);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('at phone width the toast going at the page end moves nothing on the page', async () => {
  test.setTimeout(90_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    const toast = options.locator('#message');
    await options.setViewportSize({ width: 390, height: 844 });
    await fillVault(fixture, vault);
    await save(fixture);
    await expect(toast).toContainText('binary roundtrip verified', { timeout: 30_000 });
    await expect(options.locator('#vault-state')).toHaveText(connected(vault));

    await scrollTo(options, 1e6);
    const button = options.locator('#prepare-model');
    const before = await button.boundingBox();
    expect(before).not.toBeNull();
    await expect(toast).toBeHidden({ timeout: 10_000 });
    expect(await button.boundingBox()).toEqual(before);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('the graveyard’s export notice is a success, and goes after its time', async () => {
  test.setTimeout(60_000);
  const fixture = await launchExtension('full');
  try {
    const graveyard = await fixture.context.newPage();
    await graveyard.goto(`chrome-extension://${fixture.id}/graveyard.html`);
    const toast = graveyard.locator('#message');
    const download = graveyard.waitForEvent('download');
    await graveyard.locator('#export').click();
    expect((await download).suggestedFilename()).toBe('zombie-hand-captures.json');
    await expect(toast).toHaveText(/^Exported original records and attachment bytes\./);
    await expect(toast).toHaveClass(/\bsuccess\b/);
    await expect(toast).toBeHidden({ timeout: 8_000 });
  } finally {
    await fixture.close();
  }
});

test('the status re-reads every three seconds until the waiting count has held for a minute, and again on return, Save or Test', async () => {
  test.setTimeout(180_000);
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

    // The page's clock is Playwright's, stopped and moved on by hand a second at a time.
    // Every read is still a real message to the background, answered before the next second.
    await options.bringToFront();
    await options.clock.install();
    await options.clock.pauseAt(Date.now() + 1_000);
    await options.reload();
    await expect(options.locator('#vault-state')).toHaveText(
      `${connected(vault)} 1 capture waiting to sync.`,
    );
    const loaded = await options.evaluate(() => performance.now());
    // Note, by the page's clock, each read of the background state from here on.
    await options.evaluate(() => {
      const page = window as unknown as { reads: number[]; answered: number };
      page.reads = [];
      page.answered = 0;
      const runtime = chrome.runtime as unknown as {
        sendMessage(message: unknown): Promise<unknown>;
      };
      const send = runtime.sendMessage.bind(runtime);
      runtime.sendMessage = (message) => {
        if ((message as { type?: string })?.type !== 'GET_STATE') return send(message);
        page.reads.push(performance.now());
        const reply = send(message);
        const answered = () => {
          page.answered += 1;
        };
        reply.then(answered, answered);
        return reply;
      };
    });
    /** Waits until every read the page has made is answered. */
    const answered = () =>
      expect
        .poll(() =>
          options.evaluate(() => {
            const page = window as unknown as { reads: number[]; answered: number };
            return page.answered === page.reads.length;
          }),
        )
        .toBe(true);
    /** Moves the page's clock on by whole seconds, each read answered before the next second. */
    async function advance(seconds: number): Promise<void> {
      for (let second = 0; second < seconds; second += 1) {
        await answered();
        await options.clock.runFor(1_000);
      }
      await answered();
    }
    /**
     * Runs the clock 80 seconds and returns the reads since `from`, in milliseconds after
     * it. They come three seconds apart and end a minute after it.
     */
    async function readsAfter(from: number): Promise<number[]> {
      await advance(80);
      const times = (await options.evaluate(() => (window as unknown as { reads: number[] }).reads))
        .filter((time) => time >= from)
        .map((time) => time - from);
      const distinct = [...new Set(times)];
      expect(distinct.length).toBeGreaterThan(1);
      for (const [index, time] of distinct.entries()) {
        if (index === 0) continue;
        expect(time - (distinct[index - 1] ?? 0)).toBeGreaterThanOrEqual(3_000);
        expect(time - (distinct[index - 1] ?? 0)).toBeLessThan(4_000);
      }
      expect(distinct.at(-1)).toBeGreaterThanOrEqual(57_000);
      expect(distinct.at(-1)).toBeLessThanOrEqual(64_000);
      return times;
    }
    const now = () => options.evaluate(() => performance.now());

    // A grab that cannot sync: the reads go on for a minute after the page opened, then stop.
    const opened = await readsAfter(loaded);
    expect(opened[0]).toBeLessThanOrEqual(4_000);

    // Coming back to the tab reads it at once, and for a minute again.
    let from = await now();
    await options.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    expect((await readsAfter(from))[0]).toBe(0);

    // So does a Save.
    from = await now();
    await save(fixture);
    await expect(options.locator('#message')).toHaveText('Settings saved.');
    expect((await readsAfter(from))[0]).toBe(0);
    await expect(options.locator('#vault-state')).toHaveText(
      `${connected(vault)} 1 capture waiting to sync.`,
    );

    // And so does the end of a Test, which fails with the vault gone and says so.
    from = await now();
    await options.locator('#connect').click();
    await expect(options.locator('#message')).toHaveText(unreachable, { timeout: 30_000 });
    expect((await readsAfter(from))[0]).toBe(0);
    await expect(options.locator('#vault-state')).toHaveText(
      `Sync is on for ${vault.origin}, but the last vault test failed: ${unreachable} 1 capture waiting to sync.`,
    );
  } finally {
    await fixture.close();
    if (vaultOpen) await vault.close();
  }
});

test('the status follows Chrome’s site access while the page stays open, with no reload or return to it', async () => {
  test.setTimeout(90_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    await fillVault(fixture, vault);
    await save(fixture);
    // Nothing waits to sync, so the page has no re-read of its own running.
    await expect(options.locator('#vault-state')).toHaveText(connected(vault), {
      timeout: 30_000,
    });
    const siteAccess = await siteAccessControl(fixture);
    await options.evaluate(() => {
      const page = window as unknown as { shown: number };
      page.shown = 0;
      document.addEventListener('visibilitychange', () => {
        page.shown += 1;
      });
    });
    await siteAccess('ON_CLICK');
    await expect(options.locator('#vault-state')).toHaveText(
      `The key is saved, but grabs can’t sync: Chrome’s access to ${vault.origin} is off. Press Save settings to grant it.`,
    );
    await siteAccess('ON_ALL_SITES');
    await expect(options.locator('#vault-state')).toHaveText(connected(vault));
    expect(await options.evaluate(() => (window as unknown as { shown: number }).shown)).toBe(0);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

/** Tabs through the page and names each focus stop any part of the toast covers. */
async function focusUnderToast(page: Page): Promise<{ stops: number; covered: string[] }> {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const covered: string[] = [];
  let stops = 0;
  for (let tab = 0; tab < 80; tab += 1) {
    await page.keyboard.press('Tab');
    // The page moves focus clear of the toast in the frame after it lands.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const stop = await page.evaluate(() => {
      const focused = document.activeElement;
      const toast = document.getElementById('message');
      if (!focused || focused === document.body || !toast) return null;
      if (toast.hidden) throw new Error('The toast went while focus moved');
      const a = focused.getBoundingClientRect();
      const t = toast.getBoundingClientRect();
      const across = Math.min(a.right, t.right) - Math.max(a.left, t.left);
      const down = Math.min(a.bottom, t.bottom) - Math.max(a.top, t.top);
      return { name: focused.id || focused.tagName, covered: across > 0 && down > 0 };
    });
    if (!stop) continue;
    stops += 1;
    if (stop.covered) covered.push(stop.name);
  }
  return { stops, covered };
}

test('at phone width a standing error never covers the control focus reaches, and the next action takes it away', async () => {
  test.setTimeout(120_000);
  const fixture = await launchExtension('full');
  try {
    const options = fixture.options;
    await options.setViewportSize({ width: 390, height: 844 });
    await options.reload();
    await expect(options.locator('#key-state')).not.toHaveText('Checking local settings…');
    await options.locator('#endpoint').fill('https://example.com');
    await save(fixture);
    const toast = options.locator('#message');
    await expect(toast).toHaveClass(/\berror\b/);
    const settings = await focusUnderToast(options);
    expect(settings.stops).toBeGreaterThan(15);
    expect(settings.covered).toEqual([]);

    // A mouse press in a text field the toast covers leaves the page where it is, so the
    // release lands where the press did.
    const field = options.locator('#excluded');
    await field.evaluate((box) => {
      const toast = document.getElementById('message')?.getBoundingClientRect();
      if (!toast) throw new Error('No toast');
      window.scrollBy({
        top: box.getBoundingClientRect().bottom - toast.top - 20,
        behavior: 'instant',
      });
    });
    const press = await field.evaluate((box) => {
      const toast = document.getElementById('message')?.getBoundingClientRect();
      const area = box.getBoundingClientRect();
      if (!toast || area.bottom <= toast.top) throw new Error('The field is not under the toast');
      return { x: area.left + area.width / 2, y: toast.top + 10, scrolled: scrollY };
    });
    await options.mouse.move(press.x, press.y);
    await options.mouse.down();
    await options.waitForTimeout(150);
    expect(await options.evaluate(() => scrollY)).toBe(press.scrolled);
    await options.mouse.up();
    await expect(field).toBeFocused();

    // A text box taller than the space above the toast keeps its top in view.
    await field.evaluate((box) => {
      box.style.height = '800px';
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await options.locator('#feature-haunting').focus();
    await options.keyboard.press('Tab');
    await expect(field).toBeFocused();
    await options.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(await field.evaluate((box) => box.getBoundingClientRect().top)).toBeGreaterThanOrEqual(
      0,
    );

    // The graveyard, with no vault to recover from.
    const graveyard = await fixture.context.newPage();
    await graveyard.setViewportSize({ width: 390, height: 844 });
    await graveyard.goto(`chrome-extension://${fixture.id}/graveyard.html`);
    const standing = graveyard.locator('#message');
    await graveyard.locator('#import').click();
    await expect(standing).toHaveClass(/\berror\b/);
    const graves = await focusUnderToast(graveyard);
    expect(graves.stops).toBeGreaterThan(5);
    expect(graves.covered).toEqual([]);
    // Refresh succeeds with no notice of its own, and the error is gone with it.
    await graveyard.locator('#refresh').click();
    await expect(standing).toBeHidden();
  } finally {
    await fixture.close();
  }
});
