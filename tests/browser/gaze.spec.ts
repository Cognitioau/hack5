import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, expect, chromium } from '@playwright/test';

test('gaze lab starts only explicitly, works offline and stops every fake-camera track', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'hack5-gaze-browser-'));
  const extension = resolve('dist');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  try {
    const requests: string[] = [];
    context.on('request', (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await context.setOffline(true);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/gaze.html`);
    await expect(page.locator('#gaze-status')).toContainText('Camera is off');
    expect(
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.srcObject),
    ).toBeNull();
    await page.getByRole('button', { name: 'Start local camera' }).click();
    await expect(page.locator('#gaze-status')).toContainText('Camera is running');
    // A colour-bar fake camera has no face. The product must not fabricate calibration readiness.
    await expect(page.getByRole('button', { name: 'Begin calibration' })).toBeDisabled();
    expect(
      await page
        .locator('video')
        .evaluate((video: HTMLVideoElement) =>
          (video.srcObject as MediaStream)
            .getTracks()
            .every((track) => track.readyState === 'live'),
        ),
    ).toBe(true);
    // Check the page's extra CSP independently of offline mode. A route abort is
    // a final test guard; a request reaching it would still fail the request-count assertion.
    await context.route('https://**/*', (route) => route.abort());
    await context.setOffline(false);
    expect(
      await page.evaluate(async () => {
        try {
          await fetch('https://example.com/zombie-hand-gaze-egress-probe');
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    const tracks = await page
      .locator('video')
      .evaluateHandle((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks());
    await page.getByRole('button', { name: 'Stop and clear camera session' }).click();
    await expect(page.locator('#gaze-status')).toContainText('Camera is off');
    expect(
      await tracks.evaluate((value: MediaStreamTrack[]) =>
        value.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    expect(
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.srcObject),
    ).toBeNull();
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    expect(requests).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
