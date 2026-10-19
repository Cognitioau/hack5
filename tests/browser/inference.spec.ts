import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';

test('packaged WASM embeds offline and recovers after a cold browser restart', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(resolve(tmpdir(), 'hack5-inference-'));
  const extension = resolve(directory, 'extension');
  const profile = resolve(directory, 'profile');
  await mkdir(extension);
  let context: BrowserContext | undefined;
  try {
    await build({
      absWorkingDir: process.cwd(),
      bundle: true,
      platform: 'browser',
      target: 'chrome120',
      format: 'esm',
      minify: true,
      stdin: {
        contents: `import {LocalEmbedder} from './src/adapters/inference/local-embedder.ts';
          const embedder = new LocalEmbedder();
          chrome.runtime.onMessage.addListener((message, sender, respond) => {
            if (sender.id !== chrome.runtime.id || typeof message?.text !== 'string') return false;
            embedder.embed(message.text).then(vector => respond({vector}), error => respond({error:String(error)}));
            return true;
          });`,
        resolveDir: process.cwd(),
        sourcefile: 'inference-test-host.ts',
        loader: 'ts',
      },
      outfile: resolve(extension, 'background.js'),
    });
    await cp(resolve('.cache/models'), resolve(extension, 'models'), { recursive: true });
    await mkdir(resolve(extension, 'runtime'));
    await cp(
      resolve('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'),
      resolve(extension, 'runtime/ort-wasm-simd-threaded.asyncify.wasm'),
    );
    await writeFile(
      resolve(extension, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Zombie Hand inference verification',
        version: '0.0.1',
        minimum_chrome_version: '120',
        background: { service_worker: 'background.js', type: 'module' },
        content_security_policy: {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'",
        },
      }),
    );
    await writeFile(
      resolve(extension, 'probe.html'),
      '<!doctype html><title>Inference verification</title><p>Local test fixture</p>',
    );
    const remoteRequests: string[] = [];
    const launch = async () => {
      const browser = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      browser.on('request', (request) => {
        if (/^https?:/.test(request.url())) remoteRequests.push(request.url());
      });
      await browser.setOffline(true);
      const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).hostname;
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${id}/probe.html`);
      return { browser, page };
    };
    const initial = await launch();
    context = initial.browser;
    const embed = (text: string) =>
      initial.page.evaluate(async (input) => {
        const result = (await chrome.runtime.sendMessage({ text: input })) as {
          vector?: number[];
          error?: string;
        };
        if (result.error || !result.vector) throw new Error(result.error ?? 'No vector returned');
        return result.vector;
      }, text);
    const query = await embed('A puppy is playing fetch with a ball in the park.');
    const related = await embed('A young dog runs across the grass chasing a tennis ball.');
    const unrelated = await embed(
      'A database transaction uses conditional writes to prevent lost updates.',
    );
    const repeat = await embed('A puppy is playing fetch with a ball in the park.');
    expect(query).toHaveLength(384);
    expect(query.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...query)).toBeCloseTo(1, 5);
    const similarity = (other: number[]) =>
      query.reduce((sum, value, index) => sum + value * (other[index] ?? 0), 0);
    expect(similarity(related)).toBeGreaterThan(similarity(unrelated) + 0.2);
    expect(repeat).toEqual(query);
    expect(remoteRequests).toEqual([]);
    await context.close();
    context = undefined;
    const restarted = await launch();
    context = restarted.browser;
    const afterRestart = await restarted.page.evaluate(async () => {
      const result = (await chrome.runtime.sendMessage({
        text: 'A puppy is playing fetch with a ball in the park.',
      })) as { vector?: number[]; error?: string };
      if (result.error || !result.vector)
        throw new Error(result.error ?? 'No vector returned after restart');
      return result.vector;
    });
    expect(afterRestart).toEqual(query);
    expect(remoteRequests).toEqual([]);
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
