import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, expect, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';

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

type Diagnostics = {
  calibration: {
    samples: { t: number; features: number[] | null }[];
    captured: { usedTimes: number[]; stable: boolean };
  }[];
  validation: { errorPixels: number }[];
  model: { variant: string; lambda: number; crossValidation: unknown[] };
  holdout: { medianPixels: number; points: number };
  live: {
    raw: { medianStepPixels: number };
    smoothed: { medianStepPixels: number };
    counts: Record<string, number>;
  };
};
const SETTLE_MS = 350;

/** Every key, and numeric arrays longer than one feature vector or x/y/z points (landmarks). */
function inspect(value: unknown, found = { keys: new Set<string>(), suspicious: 0 }) {
  if (Array.isArray(value)) {
    if (value.length > 10 && value.some((item) => typeof item === 'number')) found.suspicious++;
    for (const item of value) inspect(item, found);
  } else if (value && typeof value === 'object') {
    if (['x', 'y', 'z'].every((key) => key in value)) found.suspicious++;
    for (const [key, item] of Object.entries(value)) {
      found.keys.add(key);
      inspect(item, found);
    }
  }
  return found;
}

async function watchTarget(page: Page) {
  await page.evaluate(() => {
    const target = document.getElementById('gaze-target') as HTMLButtonElement;
    const log: { shown: number; enabled?: number }[] = [];
    let position = '';
    new MutationObserver(() => {
      const now = performance.now();
      const where = `${target.style.left},${target.style.top},${target.hidden}`;
      if (where !== position && !target.hidden) {
        position = where;
        log.push({ shown: now });
      }
      const last = log.at(-1);
      if (last && !target.disabled && last.enabled === undefined) last.enabled = now;
    }).observe(target, { attributes: true, attributeFilter: ['style', 'disabled', 'hidden'] });
    (window as unknown as { targetLog: typeof log }).targetLog = log;
  });
}

test('synthetic eyes: settled capture, smoothing, movement guard, export and offline evaluation', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(resolve(tmpdir(), 'hack5-gaze-harness-'));
  const extension = resolve(directory, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  // Same page, styles and controller; only the landmark source is synthetic (see the fixture).
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['tests/browser/fixtures/gaze-harness.ts'],
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'esm',
    outfile: resolve(extension, 'gaze.js'),
    allowOverwrite: true,
    define: { __CORE_ONLY__: 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 720 },
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
    const status = page.locator('#gaze-status');
    const target = page.locator('#gaze-target');
    const exportButton = page.getByRole('button', { name: 'Download session diagnostics' });
    await expect(page.locator('#gaze-auto')).not.toBeChecked();
    await expect(exportButton).toBeHidden();
    await page.getByRole('button', { name: 'Start local camera' }).click();
    await expect(status).toContainText('Face and eye landmarks found');
    await watchTarget(page);
    await page.getByRole('button', { name: 'Begin calibration' }).click();

    // Calibration by keyboard (the captured target takes focus), checks by mouse click.
    for (let index = 0; index < 14; index++) {
      await expect(target).toBeDisabled();
      await expect(target).toBeEnabled({ timeout: 5_000 });
      await expect(target).toHaveAttribute('data-state', 'captured');
      if (index < 9) {
        await expect(target).toBeFocused();
        await page.keyboard.press('Space');
      } else await target.click();
    }
    await expect(status).toContainText('Live gaze estimate');
    await expect(page.locator('#gaze-diagnostics')).toContainText('leave-one-out cross-validation');
    await expect(page.locator('#gaze-diagnostics')).toContainText('5 separate checks');

    // Click never enabled before the settling period plus a full stable window had elapsed.
    const log = await page.evaluate(
      () => (window as unknown as { targetLog: { shown: number; enabled?: number }[] }).targetLog,
    );
    expect(log).toHaveLength(14);
    for (const entry of log)
      expect((entry.enabled ?? 0) - entry.shown).toBeGreaterThanOrEqual(SETTLE_MS + 7 * 80 - 10);

    // Live phase: hold the synthetic gaze still and watch the purple dot.
    await page.evaluate(() => {
      window.gazeHarness.point = { x: 0.4, y: 0.6 };
    });
    await page.waitForTimeout(1500);
    const observed = await page.evaluate(
      () =>
        new Promise<{ x: number; y: number }[]>((done) => {
          const dot = document.getElementById('gaze-dot') as HTMLElement;
          const points: { x: number; y: number }[] = [];
          const observer = new MutationObserver(() =>
            points.push({
              x: Number.parseFloat(dot.style.left),
              y: Number.parseFloat(dot.style.top),
            }),
          );
          observer.observe(dot, { attributes: true, attributeFilter: ['style'] });
          setTimeout(() => {
            observer.disconnect();
            done(points);
          }, 3000);
        }),
    );
    expect(observed.length).toBeGreaterThan(20);
    const steps = observed.slice(1).map((point, index) => {
      const previous = observed[index] ?? point;
      return Math.hypot(point.x - previous.x, point.y - previous.y);
    });
    const medianStep = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? Infinity;
    const finalDot = observed.at(-1) ?? { x: 0, y: 0 };
    expect(Math.hypot(finalDot.x - 0.4 * 1280, finalDot.y - 0.6 * 720)).toBeLessThan(80);

    // Leaning 25% closer hides the dot and warns; returning restores it.
    await page.evaluate(() => {
      window.gazeHarness.distanceScale = 1.25;
    });
    await expect(status).toContainText('You’ve moved — recalibrate for accuracy');
    await expect(page.locator('#gaze-dot')).toBeHidden();
    await page.evaluate(() => {
      window.gazeHarness.distanceScale = 1;
    });
    await expect(status).toContainText('Live gaze estimate');
    await expect(page.locator('#gaze-dot')).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    expect(download.suggestedFilename()).toMatch(/^zombie-hand-gaze-diagnostics-.*\.json$/);
    const file = resolve(directory, 'diagnostics.json');
    await download.saveAs(file);
    const text = await readFile(file, 'utf8');
    const exported = JSON.parse(text) as Diagnostics & Record<string, unknown>;
    for (const key of [
      'schema',
      'version',
      'createdAt',
      'viewport',
      'calibration',
      'validation',
      'model',
      'holdout',
      'live',
    ])
      expect(exported).toHaveProperty(key);
    const found = inspect(exported);
    expect(
      [...found.keys].filter((key) => /landmark|image|frame|video|mesh|blob|base64/i.test(key)),
    ).toEqual([]);
    expect(found.suspicious).toBe(0);
    expect(text).not.toMatch(/data:|base64/);
    expect(exported.calibration).toHaveLength(9);
    expect(exported.validation).toHaveLength(5);
    expect(exported.holdout.points).toBe(5);
    expect(exported.model.crossValidation).toHaveLength(24);
    for (const record of exported.calibration) {
      expect(record.samples.some((sample) => sample.t < SETTLE_MS)).toBe(true);
      expect(Math.min(...record.captured.usedTimes)).toBeGreaterThanOrEqual(SETTLE_MS);
    }
    // Smoothing: the dot moves far less per update than the raw estimate it is built from.
    const { raw, smoothed } = exported.live;
    expect(smoothed.medianStepPixels).toBeLessThan(0.6 * raw.medianStepPixels);
    expect(medianStep).toBeLessThan(0.6 * raw.medianStepPixels);
    expect(exported.live.counts.moved).toBeGreaterThan(0);
    // Synthetic eyes with a linear map: a sanity bound, not a human accuracy claim.
    expect(exported.holdout.medianPixels).toBeLessThan(60);

    // The exported file is directly consumable by the offline evaluator.
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/gaze-eval.mjs', file]);
    expect(stdout).toContain('Replay of recorded frames reproduces every live capture.');
    for (const variant of ['iris', 'iris-quadratic', 'iris-head', 'full', 'legacy'])
      expect(stdout).toContain(variant);

    // Optional auto-advance: recalibrate from the live phase without clicking any target.
    await page.locator('#gaze-auto').check();
    await page.getByRole('button', { name: 'Begin calibration' }).click();
    await expect(exportButton).toBeHidden();
    await expect(status).toContainText('Calibrating');
    await expect(exportButton).toBeVisible({ timeout: 60_000 });
    await expect(status).toContainText('Live gaze estimate');

    const tracks = await page
      .locator('video')
      .evaluateHandle((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks());
    await page.getByRole('button', { name: 'Stop and clear camera session' }).click();
    await expect(status).toContainText('Camera is off');
    await expect(exportButton).toBeHidden();
    expect(
      await tracks.evaluate((value: MediaStreamTrack[]) =>
        value.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    expect(requests).toEqual([]);
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
