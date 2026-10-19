import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const manifest of ['model-assets.json', 'gaze-model-assets.json']) {
  const metadata = JSON.parse(await readFile(resolve(root, 'scripts', manifest), 'utf8'));
  const directory = resolve(root, '.cache/models', metadata.model);
  for (const file of metadata.files) {
    const destination = resolve(directory, file.path);
    const existing = await readFile(destination).catch(() => undefined);
    if (existing?.length === file.bytes && hash(existing) === file.sha256) continue;
    const base =
      metadata.baseUrl ?? `https://huggingface.co/${metadata.model}/resolve/${metadata.revision}`;
    const response = await fetch(`${base}/${file.path}`, {
      credentials: 'omit',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Model download failed (${response.status}): ${file.path}`);
    // This developer-time downloader accepts only the pinned file length and digest.
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== file.bytes || hash(data) !== file.sha256)
      throw new Error(`Model integrity mismatch: ${file.path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(`${destination}.partial`, data);
    await rename(`${destination}.partial`, destination);
    console.log(`Verified ${file.path} (${data.length} bytes)`);
  }
  console.log(`Pinned model ready: ${metadata.model}@${metadata.revision}`);
}
