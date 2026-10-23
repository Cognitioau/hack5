import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// Explicitly scoped to the separate synthetic test vault; never discover personal vaults.
const configPath = resolve('.local/test-vault/.obsidian/plugins/obsidian-local-rest-api/data.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config.apiKey || !config.crypto?.caCert)
  throw new Error('Enable the Local REST API plugin in the isolated test vault first.');
await mkdir('.cache', { recursive: true });
if (!process.argv.includes('--verified-ca-process')) {
  const caPath = resolve('.cache/test-vault-ca.pem');
  await writeFile(caPath, config.crypto.caCert, { mode: 0o600 });
  // Trust only the test plugin's CA for this child process; TLS verification stays enabled.
  const child = spawnSync(
    process.execPath,
    [resolve('scripts/probe-live-vault.mjs'), '--verified-ca-process'],
    { stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath } },
  );
  process.exit(child.status ?? 1);
}
await build({
  entryPoints: ['src/adapters/persistence/vault.ts'],
  outfile: '.cache/live-vault-adapter.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
const { createVaultClient } = await import(resolve('.cache/live-vault-adapter.mjs'));
const endpoint = `https://127.0.0.1:${config.port}`;
const folder = 'Zombie Hand Live Verification';
const settings = { endpoint, apiKey: config.apiKey, folder };
const client = createVaultClient(settings);
const checks = [];
function check(name, condition) {
  checks.push({ name, passed: !!condition });
  if (!condition) throw new Error(`Live test failed: ${name}`);
}
function capture(text) {
  const id = randomUUID();
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    operationId: id,
    createdAt: now,
    updatedAt: now,
    candidate: {
      kind: 'text',
      title: 'Synthetic live integration check',
      url: 'https://example.com/hack5-test',
      text,
    },
    lifecycle: 'active',
    lifecycleRevision: 0,
    contentRevision: 0,
    persistence: 'queued-local',
    preservation: 'text',
    indexState: 'pending',
    preparation: 'ready',
  };
}
const probe = await client.probe();
check(
  'Actual plugin create-only, ETag conflict, conditional update and binary roundtrip',
  probe.ok,
);
const record = capture(
  'A puppy chases a tennis ball across the grass. Synthetic public test evidence.',
);
const saved = await client.ensureCapture(record);
check(
  'Real HTTPS vault note and lifecycle metadata acknowledged',
  saved.status === 'saved-vault' && !!saved.vault?.metadataEtag,
);
record.vault = saved.vault;
const path = (file) => `${endpoint}/vault/${file.split('/').map(encodeURIComponent).join('/')}`;
const headers = { Authorization: `Bearer ${config.apiKey}` };
const before = await (
  await fetch(path(saved.vault.notePath), { headers, redirect: 'error' })
).text();
record.lifecycle = 'archived';
record.lifecycleRevision++;
const archived = await client.syncLifecycle(record);
check('Conditional archive persisted', archived.status === 'saved-vault');
record.vault = archived.vault;
const after = await (
  await fetch(path(saved.vault.notePath), { headers, redirect: 'error' })
).text();
check('Archive did not change raw note bytes', before === after);
const recovered = await client.importCaptures();
check(
  'Archived state recovered from actual vault',
  recovered.records.some((item) => item.id === record.id && item.lifecycle === 'archived'),
);
const uncertain = capture('Conditional writes protect a note when the browser loses a response.');
let dropped = false;
const unreliable = createVaultClient(settings, {
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (
      !dropped &&
      init?.method === 'PUT' &&
      // A note is named after what was grabbed and ends with the start of its id.
      decodeURIComponent(new URL(String(input)).pathname).endsWith(
        ` (${uncertain.id.slice(0, 8)}).md`,
      )
    ) {
      dropped = true;
      throw new TypeError('Synthetic dropped response after real write');
    }
    return response;
  },
});
const reconciled = await unreliable.ensureCapture(uncertain);
check(
  'Lost response reconciled against actual committed file',
  dropped && reconciled.status === 'saved-vault',
);
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const image = capture('A synthetic one-pixel image.');
image.candidate = {
  kind: 'image',
  title: 'Synthetic image fixture',
  url: 'https://example.com/hack5-image',
  text: 'A one-pixel fixture',
  image: {
    url: 'https://example.com/pixel.png',
    alt: 'One pixel',
    rect: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 800, viewportHeight: 600 },
  },
};
image.preservation = 'file';
image.asset = { bytes: png, mimeType: 'image/png', extension: 'png' };
const file = await client.ensureCapture(image);
check('Image attachment and its note acknowledged', file.status === 'saved-vault');
const imported = await client.importCaptures();
check(
  'Actual attachment bytes survive recovery',
  imported.records.some(
    (item) => item.id === image.id && Buffer.from(item.asset?.bytes ?? []).equals(Buffer.from(png)),
  ),
);
const edited = capture('Original test text that must never be silently overwritten.');
const original = await client.ensureCapture(edited);
check('Conflict fixture created', original.status === 'saved-vault');
const editUrl = path(original.vault.notePath);
const current = await fetch(editUrl, { headers, redirect: 'error' });
const tag = current.headers.get('etag');
await current.text();
const userEdit = 'Synthetic manual edit: retain me.';
const response = await fetch(editUrl, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'text/plain', 'If-Match': tag },
  body: userEdit,
  redirect: 'error',
});
check('Controlled edit applied with an ETag', response.ok);
const conflict = await client.ensureCapture(edited);
check('Conflicting edit reported instead of overwritten', conflict.status === 'conflict');
check(
  'Conflicting edit remains intact',
  (await (await fetch(editUrl, { headers, redirect: 'error' })).text()) === userEdit,
);
const observedChanges = await client.importCaptures();
check(
  'Recovery positively identifies changed evidence for local quarantine',
  observedChanges.unavailable?.some((item) => item.id === edited.id && item.reason === 'conflict'),
);
await writeFile(
  '.cache/live-vault-results.json',
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      pluginVersion: '5.5.2',
      tls: 'verified using test-vault CA in a dedicated child process',
      checks,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ livePlugin: true, checks, retainedSyntheticFiles: true }, null, 2));
