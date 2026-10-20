import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { AppResponse, PublicCapture } from '../../../src/core/contracts/index';
import type { VaultFixture } from './vault-fixture';

export interface ExtensionFixture {
  directory: string;
  extension: string;
  profile: string;
  context: BrowserContext;
  worker: Worker;
  id: string;
  options: Page;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function launchExtension(
  profileName: 'full' | 'core',
  pregrantFixtureOrigins = true,
  universalAccess = false,
): Promise<ExtensionFixture> {
  const directory = await mkdtemp(resolve(tmpdir(), 'hack5-capture-browser-'));
  const extension = resolve(directory, 'extension');
  const profile = resolve(directory, 'profile');
  await cp(resolve(profileName === 'core' ? 'dist-core' : 'dist'), extension, { recursive: true });
  if (pregrantFixtureOrigins) {
    // Chromium's native optional-host approval dialog cannot be accepted in
    // headless CI. Only the disposable test copy receives these exact hosts.
    // Production build artifacts, executable code and optional permissions are unchanged.
    const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')) as {
      host_permissions?: string[];
    };
    manifest.host_permissions = universalAccess
      ? profileName === 'full'
        ? ['<all_urls>']
        : ['http://*/*', 'https://*/*']
      : ['http://127.0.0.1/*', 'https://www.youtube.com/*'];
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  }
  const launch = async () => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      args: [
        // Greyscale text on every platform, as macOS draws it: Linux's subpixel
        // fringes are blue and warm, which the pixel counts would read as a
        // selection highlight or the hand's skin.
        '--disable-lcd-text',
        '--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).hostname;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(options.locator('#key-state')).not.toHaveText('Checking local settings…');
    return { context, worker, id, options };
  };
  const instance: ExtensionFixture = {
    directory,
    extension,
    profile,
    ...(await launch()),
    async restart() {
      await instance.context.close();
      Object.assign(instance, await launch());
    },
    async close() {
      await instance.context.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return instance;
}

export async function configureVault(
  fixture: ExtensionFixture,
  vault: VaultFixture,
  semantic = true,
): Promise<void> {
  await fixture.options.locator('#endpoint').fill(vault.origin);
  await fixture.options.locator('#api-key').fill(vault.key);
  await fixture.options.locator('#allow-http').check();
  await fixture.options.locator('#remember-key').check();
  await fixture.options.locator('#feature-semantic').setChecked(semantic);
  await fixture.options.locator('#feature-haunting').uncheck();
  await fixture.options.locator('#connect').click();
  await expect(fixture.options.locator('#message')).toContainText('binary roundtrip verified', {
    timeout: 30_000,
  });
}

export async function wake(fixture: ExtensionFixture, page: Page): Promise<number> {
  await page.bringToFront();
  const browser = fixture.context.browser();
  if (!browser) throw new Error('No browser');
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const target = targetInfos.find((entry) => entry.url === page.url());
    if (!target) throw new Error('No tab target');
    // Opening the toolbar popup grants Chrome's actual activeTab capability.
    // The test then dismisses it and injects the shipped content entry through
    // the same production scripting API that the popup's grab uses.
    await session.send('Extensions.triggerAction', { id: fixture.id, targetId: target.targetId });
    const popupUrl = `chrome-extension://${fixture.id}/popup.html`;
    let popup: string | undefined;
    await expect
      .poll(async () => {
        popup = (await session.send('Target.getTargets')).targetInfos.find(
          (entry) => entry.url === popupUrl,
        )?.targetId;
        return popup !== undefined;
      })
      .toBe(true);
    if (popup) await session.send('Target.closeTarget', { targetId: popup });
  } finally {
    await session.detach();
  }
  const tabId = await fixture.worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((entry) => entry.url === url);
    if (tab?.id === undefined) throw new Error('Fixture tab unavailable');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return tab.id;
  }, page.url());
  await expect(page.locator('[data-zombie-hand-ui]')).toBeAttached();
  return tabId;
}

export interface ToolbarPopup {
  /** Runs an expression in the popup and returns its value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Whether the popup is still open. */
  open(): Promise<boolean>;
  /** Dismisses the popup if it is still open. */
  close(): Promise<void>;
}

/**
 * Clicks the toolbar button over `page`, as a person does. Chrome opens the
 * real popup, which Playwright does not list as a page, so it is driven over CDP.
 */
export async function openPopup(fixture: ExtensionFixture, page: Page): Promise<ToolbarPopup> {
  await page.bringToFront();
  const browser = fixture.context.browser();
  if (!browser) throw new Error('No browser');
  const session = await browser.newBrowserCDPSession();
  const popupUrl = `chrome-extension://${fixture.id}/popup.html`;
  const popupTarget = async () =>
    (await session.send('Target.getTargets')).targetInfos.find((entry) => entry.url === popupUrl);
  const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((entry) => entry.url === page.url());
  if (!tab) throw new Error('No tab target');
  await session.send('Extensions.triggerAction', { id: fixture.id, targetId: tab.targetId });
  await expect.poll(async () => (await popupTarget()) !== undefined).toBe(true);
  const target = await popupTarget();
  if (!target) throw new Error('The popup did not open');
  // Playwright's CDP session carries no child session id, so the popup is
  // reached through the browser target's message relay.
  const { sessionId } = await session.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  });
  type Reply = { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };
  let next = 0;
  const replies = new Map<number, (reply: Reply) => void>();
  session.on('Target.receivedMessageFromTarget', (event) => {
    const reply = JSON.parse(event.message) as Reply;
    if (reply.id !== undefined) replies.get(reply.id)?.(reply);
  });
  const popup: ToolbarPopup = {
    async evaluate<T>(expression: string): Promise<T> {
      const id = ++next;
      const reply = await new Promise<Reply>((resolve) => {
        replies.set(id, resolve);
        void session.send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            // A click a person makes: the popup may ask Chrome for site access.
            params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
          }),
        });
      });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result?.result?.value as T;
    },
    async open() {
      return (await popupTarget()) !== undefined;
    },
    async close() {
      const open = await popupTarget();
      if (open) await session.send('Target.closeTarget', { targetId: open.targetId });
      await session.detach().catch(() => undefined);
    },
  };
  // Wait until the popup has read the extension's state.
  await expect
    .poll(() => popup.evaluate<string>('document.getElementById("mode").textContent'))
    .not.toBe('Checking…');
  return popup;
}

export async function state(fixture: ExtensionFixture): Promise<PublicCapture[]> {
  const response = await fixture.options.evaluate(
    () => chrome.runtime.sendMessage({ v: 1, type: 'GET_STATE' }) as Promise<AppResponse>,
  );
  if (!response.ok) throw new Error(response.error);
  return response.captures ?? [];
}

export async function isolatedMessage(
  fixture: ExtensionFixture,
  tabId: number,
  message: unknown,
): Promise<AppResponse> {
  return fixture.worker.evaluate(
    async ({ tabId: id, message: payload }) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: async (raw: unknown) => chrome.runtime.sendMessage(raw),
        args: [payload],
      });
      return results[0]?.result as AppResponse;
    },
    { tabId, message },
  );
}

export async function captureAt(
  page: Page,
  selector: string,
  gesture: 'keyboard' | 'circle' = 'keyboard',
): Promise<void> {
  const bounds = await page.locator(selector).boundingBox();
  if (!bounds) throw new Error('Capture target unavailable');
  const x = bounds.x + Math.min(100, bounds.width / 2);
  const y = bounds.y + Math.min(18, bounds.height / 2);
  await page.mouse.move(x, y);
  if (gesture === 'keyboard') {
    await page.keyboard.press('Alt+Shift+Z');
    return;
  }
  await drawCircle(page, { x, y }, 'Shift');
}

/** Trusted hardware-style input. Start on the rim, with no dwell or mouse drag. */
export async function drawCircle(
  page: Page,
  center: { x: number; y: number },
  modifier: 'Shift' | 'Control' | null,
  portion = 1,
): Promise<void> {
  await page.mouse.move(center.x + 52, center.y);
  if (modifier) await page.keyboard.down(modifier);
  try {
    for (let step = 1; step <= 64 * portion; step++) {
      const angle = (step / 64) * Math.PI * 2;
      await page.mouse.move(center.x + Math.cos(angle) * 52, center.y + Math.sin(angle) * 52);
      await page.waitForTimeout(6);
    }
  } finally {
    if (modifier) await page.keyboard.up(modifier);
  }
}

export async function screenshotArtifact(page: Page, name: string): Promise<void> {
  const directory = resolve('.cache/browser-artifacts');
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
}
