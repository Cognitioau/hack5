import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, process.argv.includes('--core') ? 'dist-core' : 'dist');
const manifest = JSON.parse(await readFile(resolve(destination, 'manifest.json'), 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
assert(manifest.manifest_version === 3, 'Manifest V3 required');
assert(Number(manifest.minimum_chrome_version) >= 120, 'Minimum Chromium version missing');
assert(
  manifest.background?.service_worker === 'background.js' && manifest.background.type === 'module',
  'Invalid worker entrypoint',
);
assert(!manifest.host_permissions?.length, 'No mandatory network host permissions are allowed');
assert(!manifest.externally_connectable, 'External messaging is not supported');
assert(
  !manifest.web_accessible_resources?.length,
  'Model/private assets must not be web accessible',
);
const allowed = new Set(['activeTab', 'scripting', 'storage', 'alarms']);
assert(
  manifest.permissions.every((permission) => allowed.has(permission)),
  'Unreviewed required permission',
);
const csp = manifest.content_security_policy?.extension_pages ?? '';
assert(
  csp.includes("script-src 'self' 'wasm-unsafe-eval'") && csp.includes("object-src 'none'"),
  'CSP must permit packaged WASM only',
);
assert(
  !/https?:|unsafe-inline|\s'unsafe-eval'/.test(csp),
  'CSP permits remote/unsafe script sources',
);
for (const filename of [
  'background.js',
  'content.js',
  'options.js',
  'graveyard.js',
  'options.html',
  'graveyard.html',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]) {
  assert(
    (await readFile(resolve(destination, filename))).length > 0,
    `Missing or empty ${filename}`,
  );
}
const core = process.argv.includes('--core');
const origins = manifest.optional_host_permissions ?? [];
assert(
  core
    ? origins.length === 2 && origins.includes('http://*/*') && origins.includes('https://*/*')
    : origins.length === 1 && origins[0] === '<all_urls>',
  'Full uses optional all-sites for cross-tab crops; core uses optional HTTP(S) only',
);
assert(!manifest.host_permissions?.length, 'No site access may be granted at install time');
assert(
  !manifest.content_scripts?.length,
  'Universal activation must remain an explicit runtime choice',
);

for (const filename of ['options.html', 'graveyard.html', ...(!core ? ['gaze.html'] : [])]) {
  const html = await readFile(resolve(destination, filename), 'utf8');
  if (filename === 'gaze.html')
    assert(
      html.includes('content="connect-src \'self\'"'),
      'Gaze page must block upstream telemetry and every external connection',
    );
  assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), `Inline executable script in ${filename}`);
  assert(!/\bon[a-z]+\s*=|javascript:/i.test(html), `Unsafe inline handler in ${filename}`);
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    assert(!match[1].startsWith('/') && !match[1].includes('..'), `Invalid asset path ${match[1]}`);
    await readFile(resolve(destination, match[1]));
  }
}
const metadata = JSON.parse(await readFile(resolve(destination, 'model-assets.json'), 'utf8'));
const models = [metadata];
if (!core)
  models.push(JSON.parse(await readFile(resolve(destination, 'gaze-model-assets.json'), 'utf8')));
for (const model of models)
  for (const file of model.files) {
    const bytes = await readFile(resolve(destination, 'models', model.model, file.path));
    assert(
      bytes.length === file.bytes &&
        createHash('sha256').update(bytes).digest('hex') === file.sha256,
      `Packaged model integrity mismatch ${file.path}`,
    );
  }
const wasm = await readFile(resolve(destination, 'runtime/ort-wasm-simd-threaded.asyncify.wasm'));
assert(wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])), 'Packaged runtime is not WASM');
const installedWasm = await readFile(
  resolve(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'),
);
assert(
  createHash('sha256').update(wasm).digest('hex') ===
    createHash('sha256').update(installedWasm).digest('hex'),
  'Packaged WASM differs from the lockfile-installed runtime',
);
if (!core) {
  for (const file of [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ]) {
    const packaged = await readFile(resolve(destination, 'gaze-runtime', file));
    const installed = await readFile(
      resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm', file),
    );
    assert(
      createHash('sha256').update(packaged).digest('hex') ===
        createHash('sha256').update(installed).digest('hex'),
      `Packaged gaze runtime differs from the lockfile-installed dependency: ${file}`,
    );
  }
}
async function verifyArtifactNames(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(
      entry.isDirectory() || entry.isFile(),
      'Non-regular file or symlink in extension artifact',
    );
    assert(
      !entry.name.startsWith('.') &&
        !entry.name.endsWith('.map') &&
        !['node_modules', 'test-vault', 'browser-profile'].includes(entry.name),
      'Private, development or source-map files in artifact',
    );
    if (entry.isDirectory()) await verifyArtifactNames(resolve(directory, entry.name));
  }
}
await verifyArtifactNames(destination);
if (core) {
  for (const file of ['gaze.html', 'gaze.js', 'gaze-runtime', 'models/mediapipe-face-landmarker']) {
    assert(
      !(await readFile(resolve(destination, file)).then(
        () => true,
        (error) => error.code !== 'ENOENT',
      )),
      'Core package contains gaze assets',
    );
  }
}
console.log(
  'Verified packaged entrypoints, permissions, CSP, model hashes, WASM header, and public artifact exclusions.',
);
