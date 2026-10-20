import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = process.argv.includes('--core');
const destination = resolve(root, core ? 'dist-core' : 'dist');
const metadata = JSON.parse(await readFile(resolve(root, 'scripts/model-assets.json'), 'utf8'));
const gazeMetadata = core
  ? undefined
  : JSON.parse(await readFile(resolve(root, 'scripts/gaze-model-assets.json'), 'utf8'));
// Verify before removing an existing build. Download is explicit, never hidden inside compilation.
for (const model of [metadata, ...(gazeMetadata ? [gazeMetadata] : [])])
  for (const file of model.files) {
    const bytes = await readFile(resolve(root, '.cache/models', model.model, file.path)).catch(
      () => undefined,
    );
    if (
      !bytes ||
      bytes.length !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    ) {
      throw new Error(`Missing or modified model asset ${file.path}. Run npm run model:fetch.`);
    }
  }
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  minify: true,
  treeShaking: true,
  legalComments: 'linked',
  metafile: true,
  define: { __CORE_ONLY__: String(core), 'process.env.NODE_ENV': '"production"' },
};
const bundles = await Promise.all([
  build({
    ...common,
    entryPoints: ['src/bootstrap/background.ts'],
    outfile: resolve(destination, 'background.js'),
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: ['src/bootstrap/content.ts'],
    outfile: resolve(destination, 'content.js'),
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: ['src/bootstrap/options.ts'],
    outfile: resolve(destination, 'options.js'),
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: ['src/bootstrap/graveyard.ts'],
    outfile: resolve(destination, 'graveyard.js'),
    format: 'esm',
  }),
  ...(!core
    ? [
        build({
          ...common,
          entryPoints: ['src/bootstrap/gaze.ts'],
          outfile: resolve(destination, 'gaze.js'),
          format: 'esm',
        }),
      ]
    : []),
]);
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
if (core) manifest.optional_host_permissions = ['http://*/*', 'https://*/*'];
await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const name of [
  'options.html',
  'graveyard.html',
  'app.css',
  'ui.css',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]) {
  await cp(resolve(root, name), resolve(destination, name));
}
// Package only allowlisted verified files, never arbitrary contents of a developer's cache.
for (const model of [metadata, ...(gazeMetadata ? [gazeMetadata] : [])])
  for (const file of model.files) {
    const target = resolve(destination, 'models', model.model, file.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(root, '.cache/models', model.model, file.path), target);
  }
await mkdir(resolve(destination, 'assets'), { recursive: true });
// One packaged grave hand per footage take; src/ui/grave-sprite.ts names them in the same order.
const { takes } = JSON.parse(await readFile(resolve(root, 'scripts/hand/takes.json'), 'utf8'));
for (const [index] of takes.entries())
  await cp(
    resolve(root, `assets/grave-hand-${index}.bin`),
    resolve(destination, `assets/grave-hand-${index}.bin`),
  );
await mkdir(resolve(destination, 'runtime'), { recursive: true });
await cp(
  resolve(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'),
  resolve(destination, 'runtime/ort-wasm-simd-threaded.asyncify.wasm'),
);
await cp(resolve(root, 'scripts/model-assets.json'), resolve(destination, 'model-assets.json'));
if (!core) {
  await cp(resolve(root, 'gaze.html'), resolve(destination, 'gaze.html'));
  await cp(resolve(root, 'gaze.css'), resolve(destination, 'gaze.css'));
  await cp(
    resolve(root, 'scripts/gaze-model-assets.json'),
    resolve(destination, 'gaze-model-assets.json'),
  );
  await mkdir(resolve(destination, 'gaze-runtime'), { recursive: true });
  for (const file of [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ]) {
    await cp(
      resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm', file),
      resolve(destination, 'gaze-runtime', file),
    );
  }
}
await mkdir(resolve(destination, 'licenses'), { recursive: true });
for (const [name, file] of [
  ['transformers-Apache-2.0.txt', 'node_modules/@huggingface/transformers/LICENSE'],
  ['huggingface-jinja-MIT.txt', 'node_modules/@huggingface/jinja/LICENSE'],
  ['huggingface-tokenizers-Apache-2.0.txt', 'node_modules/@huggingface/tokenizers/LICENSE'],
  ['onnxruntime-MIT.txt', 'licenses/onnxruntime-MIT.txt'],
  ['onnxruntime-ThirdPartyNotices.txt', 'licenses/onnxruntime-ThirdPartyNotices.txt'],
  ['zod-MIT.txt', 'node_modules/zod/LICENSE'],
  ['yaml-ISC.txt', 'node_modules/yaml/LICENSE'],
])
  await cp(resolve(root, file), resolve(destination, 'licenses', name));
if (!core)
  await cp(
    resolve(root, 'licenses/mediapipe-Apache-2.0.txt'),
    resolve(destination, 'licenses/mediapipe-Apache-2.0.txt'),
  );
const meta = { profile: core ? 'core' : 'full', bundles: bundles.map((item) => item.metafile) };
await mkdir(resolve(root, '.cache'), { recursive: true });
await writeFile(
  resolve(root, `.cache/build-${meta.profile}.json`),
  `${JSON.stringify(meta, null, 2)}\n`,
);
if (core) {
  const retained = bundles.flatMap((result) =>
    Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(
          ([name, value]) =>
            /^(?:src\/(?:features|adapters)\/(?:image|youtube|gaze)\/|node_modules\/@mediapipe\/)/.test(
              name,
            ) && value.bytesInOutput > 0,
        )
        .map(([name]) => name),
    ),
  );
  if (retained.length)
    throw new Error(
      `Core build retained optional feature code: ${[...new Set(retained)].join(', ')}`,
    );
}
console.log(
  `Built ${core ? 'core' : 'full'} extension in ${core ? 'dist-core' : 'dist'} (packaged model and WASM, no CDN dependency).`,
);
