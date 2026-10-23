import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { AppResponse, CaptureCandidate, PublicCapture } from '../../src/core/contracts/index';
import {
  captureAt,
  configureVault,
  isolatedMessage,
  launchExtension,
  screenshotArtifact,
  state,
  wake,
  type ExtensionFixture,
} from './helpers/extension-fixture';
import { captureNote, startVaultFixture, youtubeHtml } from './helpers/vault-fixture';

async function saved(
  fixture: ExtensionFixture,
  predicate: (capture: PublicCapture) => boolean,
): Promise<PublicCapture> {
  try {
    await expect
      .poll(async () => (await state(fixture)).find(predicate)?.persistence, { timeout: 30_000 })
      .toBe('saved-vault');
  } catch (error) {
    for (const [index, page] of fixture.context.pages().entries())
      await screenshotArtifact(page, `capture-failure-${index}`);
    throw error;
  }
  const capture = (await state(fixture)).find(predicate);
  if (!capture) throw new Error('Saved capture missing');
  return capture;
}

test('production manifest denies host access before any user grant', async () => {
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full', false);
  try {
    expect(
      await fixture.worker.evaluate(() =>
        chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }),
      ),
    ).toBe(false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    const injection = await fixture.worker.evaluate(async (url) => {
      // With neither host access nor activeTab, Chrome conceals the tab URL;
      // target the active tab and observe the actual injection rejection.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error(`No fixture tab for ${url}`);
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        return 'unexpected-success';
      } catch {
        return 'denied';
      }
    }, article.url());
    expect(injection).toBe('denied');
    expect(await article.locator('[data-zombie-hand-ui]').count()).toBe(0);
    expect(
      await article.evaluate(() =>
        Boolean((window as Window & { chrome?: { runtime?: unknown } }).chrome?.runtime),
      ),
    ).toBe(false);
    const response = await fixture.options.evaluate(
      async ({ endpoint, apiKey }) => {
        const current = (await chrome.runtime.sendMessage({
          v: 1,
          type: 'GET_STATE',
        })) as AppResponse;
        if (!current.ok || !current.settings) throw new Error('No settings');
        await chrome.runtime.sendMessage({
          v: 1,
          type: 'SAVE_SETTINGS',
          settings: { ...current.settings, endpoint, allowInsecureLoopback: true },
          apiKey,
        });
        return chrome.runtime.sendMessage({ v: 1, type: 'PROBE_VAULT' }) as Promise<AppResponse>;
      },
      { endpoint: vault.origin, apiKey: vault.key },
    );
    expect(response.ok).toBe(false);
    expect(vault.requests).toEqual([]);
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('full extension captures with trusted input, preserves crops and captions, searches locally and keeps archives after restart', async () => {
  test.setTimeout(180_000);
  const vault = await startVaultFixture();
  const fixture = await launchExtension('full');
  try {
    await configureVault(fixture, vault);
    await screenshotArtifact(fixture.options, 'full-options');
    const beforeMediaGrant = await fixture.worker.evaluate(() => chrome.permissions.getAll());
    await fixture.options.locator('#media-origin').fill('https://127.0.0.1');
    await fixture.options.locator('#grant-media').click();
    await expect(fixture.options.locator('#message')).toContainText(
      'Local or IP media destinations are not permitted',
    );
    expect(await fixture.worker.evaluate(() => chrome.permissions.getAll())).toEqual(
      beforeMediaGrant,
    );
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    const tabId = await wake(fixture, article);
    await captureAt(article, '#dog', 'circle');
    const dog = await saved(fixture, (capture) => capture.candidate.text.includes('young dog'));
    expect(dog.candidate.kind).toBe('text');
    expect(captureNote(vault, dog.id)).toContain('young dog');
    await screenshotArtifact(article, 'full-text-capture');

    const credentialRead = await fixture.worker.evaluate(async (id) => {
      const result = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: async () => {
          const read = async (area: chrome.storage.StorageArea) => {
            try {
              return await area.get('vaultKey');
            } catch {
              return { denied: true };
            }
          };
          return {
            local: await read(chrome.storage.local),
            session: await read(chrome.storage.session),
          };
        },
      });
      return result[0]?.result;
    }, tabId);
    expect(JSON.stringify(credentialRead)).not.toContain(vault.key);
    expect(credentialRead).toEqual({ local: { denied: true }, session: { denied: true } });
    const malformed = await isolatedMessage(fixture, tabId, {
      v: 1,
      type: 'ARM',
      candidate: dog.candidate,
      pageUrl: article.url(),
      vaultPath: '../private.md',
    });
    expect(malformed.ok).toBe(false);
    expect(
      (
        await isolatedMessage(fixture, tabId, {
          v: 1,
          type: 'CAPTURE',
          token: randomUUID(),
          operationId: randomUUID(),
        })
      ).ok,
    ).toBe(false);
    const collisionArm = await isolatedMessage(fixture, tabId, {
      v: 1,
      type: 'ARM',
      candidate: dog.candidate,
      pageUrl: article.url(),
    });
    expect(collisionArm.ok).toBe(true);
    if (!collisionArm.ok || !collisionArm.token) throw new Error('No arm token');
    expect(
      (
        await isolatedMessage(fixture, tabId, {
          v: 1,
          type: 'CAPTURE',
          token: collisionArm.token,
          operationId: dog.id,
        })
      ).ok,
    ).toBe(false);

    await captureAt(article, '#fern');
    const image = await saved(fixture, (capture) => capture.candidate.kind === 'image');
    expect(image.preservation).toBe('screenshot');
    const attachment = vault.files.get(`Zombie Brain/attachments/${image.id}.png`);
    expect(attachment).toBeDefined();
    const pixels = await article.evaluate(
      async (values) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(values)], { type: 'image/png' }),
        );
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No canvas');
        context.drawImage(bitmap, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let alteredPixels = 0;
        for (let index = 0; index < data.length; index += 4)
          if (
            data[index] !== 31 ||
            data[index + 1] !== 137 ||
            data[index + 2] !== 91 ||
            data[index + 3] !== 255
          )
            alteredPixels++;
        bitmap.close();
        return { width: canvas.width, height: canvas.height, alteredPixels };
      },
      [...(attachment ?? [])],
    );
    expect(pixels).toEqual({ width: 240, height: 120, alteredPixels: 0 });
    expect(
      await article
        .locator('[data-zombie-hand-ui]')
        .evaluate((node) => getComputedStyle(node).display),
    ).not.toBe('none');

    await expect
      .poll(
        async () => (await state(fixture)).find((capture) => capture.id === dog.id)?.indexState,
        { timeout: 60_000 },
      )
      .toBe('ready');
    const retrieval = await fixture.options.evaluate(
      () =>
        chrome.runtime.sendMessage({
          v: 1,
          type: 'SEARCH',
          query: 'A puppy enjoying a game of fetch outdoors',
        }) as Promise<AppResponse>,
    );
    expect(retrieval.ok).toBe(true);
    if (!retrieval.ok) throw new Error(retrieval.error);
    expect(retrieval.results?.[0]?.capture.id).toBe(dog.id);
    expect(retrieval.results?.[0]?.mode).toBe('semantic');

    await fixture.context.route('https://www.youtube.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: youtubeHtml }),
    );
    const youtube = await fixture.context.newPage();
    await youtube.goto('https://www.youtube.com/watch?v=abcdefghijk');
    await youtube.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 45;
    });
    await wake(fixture, youtube);
    await captureAt(youtube, 'video');
    const video = await saved(fixture, (capture) => capture.candidate.kind === 'youtube');
    expect(video.candidate.video).toMatchObject({
      id: 'abcdefghijk',
      seconds: 45,
      transcript: { status: 'partial', provenance: 'youtube-panel' },
    });
    expect(video.candidate.video?.transcript.cues).toHaveLength(3);
    expect(video.candidate.url).toBe('https://www.youtube.com/watch?v=abcdefghijk&t=45s');
    const videoNote = captureNote(vault, video.id) ?? '';
    expect(videoNote).toContain('camouflage');
    expect(videoNote).toContain('t=45s');
    await screenshotArtifact(youtube, 'full-youtube-fixture');
    await youtube.evaluate(() =>
      document.querySelector('ytd-engagement-panel-section-list-renderer')?.remove(),
    );
    await captureAt(youtube, 'video');
    const withoutTranscript = await saved(
      fixture,
      (capture) => capture.candidate.kind === 'youtube' && capture.id !== video.id,
    );
    expect(withoutTranscript.candidate.video?.transcript).toMatchObject({
      status: 'unavailable',
      cues: [],
    });

    // A real document replacement invalidates the previous document's token.
    await article.bringToFront();
    await wake(fixture, article);
    const candidate: CaptureCandidate = {
      kind: 'text',
      title: 'Stale fixture',
      url: article.url(),
      text: 'A stale document must not capture this.',
    };
    const arm = await isolatedMessage(fixture, tabId, {
      v: 1,
      type: 'ARM',
      candidate,
      pageUrl: article.url(),
    });
    expect(arm.ok).toBe(true);
    if (!arm.ok || !arm.token) throw new Error('No stale arm token');
    await article.reload();
    await wake(fixture, article);
    expect(
      (
        await isolatedMessage(fixture, tabId, {
          v: 1,
          type: 'CAPTURE',
          token: arm.token,
          operationId: randomUUID(),
        })
      ).ok,
    ).toBe(false);

    const graveyard = await fixture.context.newPage();
    await graveyard.goto(`chrome-extension://${fixture.id}/graveyard.html`);
    await graveyard.locator('#transcript-import summary').click();
    await graveyard.locator('#transcript-url').fill('https://www.youtube.com/watch?v=lmnopqrstuv');
    await graveyard.locator('#transcript-title').fill('A pasted astronomy lesson');
    await graveyard.locator('#transcript-seconds').fill('45');
    await graveyard
      .locator('#transcript-text')
      .fill('An untimed paragraph must never become timed evidence.');
    const beforeImport = (await state(fixture)).length;
    await graveyard.getByRole('button', { name: 'Save transcript moment' }).click();
    await expect(graveyard.locator('#message')).toBeVisible();
    expect((await state(fixture)).length).toBe(beforeImport);
    await graveyard
      .locator('#transcript-text')
      .fill(
        'WEBVTT\n\n00:30.000 --> 00:40.000\nA nebula contains gas and dust.\n\n00:45.000 --> 00:50.000\nA new star forms inside the cloud.',
      );
    await graveyard.getByRole('button', { name: 'Save transcript moment' }).click();
    const imported = await saved(
      fixture,
      (capture) => capture.candidate.title === 'A pasted astronomy lesson',
    );
    expect(imported.candidate.video?.transcript).toMatchObject({
      status: 'partial',
      provenance: 'import',
      cues: [
        { start: 30, duration: 10 },
        { start: 45, duration: 5 },
      ],
    });
    await expect
      .poll(
        async () =>
          (await state(fixture)).find((capture) => capture.id === imported.id)?.indexState,
        { timeout: 30_000 },
      )
      .toBe('ready');
    await graveyard
      .locator('#query')
      .fill('A nebula contains gas and dust. A new star forms inside the cloud.');
    await graveyard.getByRole('button', { name: 'Find it' }).click();
    const importCard = graveyard
      .locator('.capture-card')
      .filter({ hasText: 'A pasted astronomy lesson' });
    await expect(importCard).toContainText('SEMANTIC MATCH');
    const cueLink = new URL(
      (await importCard.getByRole('link', { name: 'Return to source' }).getAttribute('href')) ??
        'https://invalid.example',
    );
    expect(cueLink.searchParams.get('v')).toBe('lmnopqrstuv');
    expect(cueLink.searchParams.get('t')).toBe('30s');
    await graveyard.getByRole('button', { name: 'Refresh', exact: true }).click();
    const dogCard = graveyard.locator('.capture-card').filter({ hasText: 'young dog' });
    await dogCard.getByRole('button', { name: 'Spit back' }).click();
    const archived = await saved(
      fixture,
      (capture) => capture.id === dog.id && capture.lifecycle === 'archived',
    );
    expect(archived.lifecycle).toBe('archived');
    expect(
      JSON.parse(vault.files.get(`Zombie Brain/metadata/${dog.id}.json`)?.toString() ?? '{}')
        .lifecycle.status,
    ).toBe('archived');
    expect(captureNote(vault, dog.id) !== undefined).toBe(true);
    await screenshotArtifact(graveyard, 'full-graveyard');
    await fixture.restart();
    expect((await state(fixture)).find((capture) => capture.id === dog.id)?.lifecycle).toBe(
      'archived',
    );
    const afterRestart = await fixture.options.evaluate(
      () =>
        chrome.runtime.sendMessage({
          v: 1,
          type: 'SEARCH',
          query: 'young dog tennis ball',
        }) as Promise<AppResponse>,
    );
    expect(afterRestart.ok).toBe(true);
    if (!afterRestart.ok) throw new Error(afterRestart.error);
    expect(afterRestart.results?.some((result) => result.capture.id === dog.id)).toBe(false);
    expect(
      vault.requests
        .filter((request) => request.method === 'PUT')
        .every((request) => request.authorized && request.conditional),
    ).toBe(true);

    await fixture.options.locator('#feature-images').uncheck();
    await fixture.options.locator('#feature-youtube').uncheck();
    await fixture.options.locator('#feature-semantic').uncheck();
    await fixture.options.locator('#feature-haunting').uncheck();
    await fixture.options.getByRole('button', { name: 'Save settings' }).click();
    await expect(fixture.options.locator('#message')).toContainText('Settings saved');
    const disabledPage = await fixture.context.newPage();
    await disabledPage.goto(`${vault.origin}/article`);
    await wake(fixture, disabledPage);
    const count = (await state(fixture)).length;
    await captureAt(disabledPage, '#fern');
    await disabledPage.waitForTimeout(300);
    expect((await state(fixture)).length).toBe(count);
    await captureAt(disabledPage, '#database');
    const text = await saved(fixture, (capture) =>
      capture.candidate.text.includes('Database transactions'),
    );
    expect(text.candidate.kind).toBe('text');
  } finally {
    await fixture.close();
    await vault.close();
  }
});

test('core build keeps real text capture and retrieval while optional media adapters are absent', async () => {
  const vault = await startVaultFixture();
  const fixture = await launchExtension('core');
  try {
    await configureVault(fixture, vault, false);
    await expect(fixture.options.locator('#feature-images')).toBeDisabled();
    await expect(fixture.options.locator('#feature-youtube')).toBeDisabled();
    const graveyard = await fixture.context.newPage();
    await graveyard.goto(`chrome-extension://${fixture.id}/graveyard.html`);
    await expect(graveyard.locator('#transcript-import')).toBeHidden();
    const unsupported = await graveyard.evaluate(
      () =>
        chrome.runtime.sendMessage({
          v: 1,
          type: 'IMPORT_TRANSCRIPT',
          operationId: crypto.randomUUID(),
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          title: 'Core must reject this',
          text: '[0:01] Real timed text.',
          seconds: 1,
        }) as Promise<AppResponse>,
    );
    expect(unsupported.ok).toBe(false);
    const article = await fixture.context.newPage();
    await article.goto(`${vault.origin}/article`);
    const tabId = await wake(fixture, article);
    const status = await isolatedMessage(fixture, tabId, { v: 1, type: 'CONTENT_STATUS' });
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.features).toMatchObject({ images: false, youtube: false, gaze: false });
    await captureAt(article, '#database');
    const capture = await saved(fixture, (entry) =>
      entry.candidate.text.includes('Database transactions'),
    );
    const response = await fixture.options.evaluate(
      () =>
        chrome.runtime.sendMessage({
          v: 1,
          type: 'SEARCH',
          query: 'conditional writes',
        }) as Promise<AppResponse>,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    expect(response.results?.[0]).toMatchObject({ capture: { id: capture.id }, mode: 'keyword' });
    await captureAt(article, '#fern');
    await article.waitForTimeout(300);
    expect((await state(fixture)).length).toBe(1);
    await screenshotArtifact(article, 'core-text-capture');
  } finally {
    await fixture.close();
    await vault.close();
  }
});
