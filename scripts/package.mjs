import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.cache/packages');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = async (...args) => (await run('git', args, { cwd: root })).stdout.trim();
const sourceFiles = (await git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
  .split('\0')
  .filter(Boolean)
  .sort();
const snapshot = createHash('sha256');
for (const file of sourceFiles) {
  const bytes = await readFile(resolve(root, file));
  snapshot.update(`${Buffer.byteLength(file)}:${file}:${bytes.length}:`);
  snapshot.update(bytes);
}
const source = {
  repository: 'https://github.com/Cognitioau/hack5',
  commit: await git('rev-parse', 'HEAD'),
  dirty: !!(await git('status', '--porcelain')),
  snapshotSha256: snapshot.digest('hex'),
};
const createdAt = new Date().toISOString();
const manifest = { version: pkg.version, createdAt, source, packages: [] };
await mkdir(output, { recursive: true });

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Refusing a non-regular build artifact: ${entry.name}`);
  }
  return files.sort();
}

for (const profile of ['full', 'core']) {
  await run(
    process.execPath,
    ['scripts/check-package.mjs', ...(profile === 'core' ? ['--core'] : [])],
    { cwd: root },
  );
  const built = resolve(root, profile === 'core' ? 'dist-core' : 'dist');
  const staging = await mkdtemp(resolve(tmpdir(), 'hack5-package-'));
  const name = `zombie-brain-${pkg.version}-${profile}.zip`;
  const archive = resolve(output, name);
  try {
    // The only archive inputs are validated regular build files and public provenance.
    const files = await walk(built);
    const inventory = [];
    for (const file of files) {
      const path = relative(built, file).replaceAll('\\', '/');
      const target = resolve(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(file, target);
      const bytes = await readFile(file);
      inventory.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await writeFile(
      resolve(staging, 'BUILD_INFO.json'),
      `${JSON.stringify({ version: pkg.version, profile, createdAt, source, files: inventory }, null, 2)}\n`,
    );
    await rm(archive, { force: true });
    await run('zip', ['-X', '-q', '-r', archive, '.'], { cwd: staging });
    // Verify archive structure/data after writing, not just the source directory.
    await run('unzip', ['-tq', archive]);
    const bytes = await readFile(archive);
    manifest.packages.push({
      file: name,
      profile,
      bytes: bytes.length,
      sha256: sha256(bytes),
      buildFiles: inventory.length,
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
await writeFile(resolve(output, 'packages.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  resolve(output, 'SHA256SUMS'),
  manifest.packages.map((item) => `${item.sha256}  ${item.file}\n`).join(''),
);
console.log(JSON.stringify(manifest, null, 2));
