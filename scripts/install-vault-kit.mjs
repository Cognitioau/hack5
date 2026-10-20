// Installs the graveyard wiki kit into a Zombie Hand vault folder.
//
//   node scripts/install-vault-kit.mjs "<vault>/Zombie Hand"
//
// Copies vault-kit/ into the folder: AGENTS.md, CLAUDE.md, and claude/ as .claude/ (the settings
// that confine the agent to wiki/, and the /ingest, /ask and /lint skills). Create-only: a file
// that already exists is never overwritten, so edits made in the vault survive a reinstall.
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vault-kit');
const [target, ...extra] = process.argv.slice(2);
if (!target || extra.length) {
  console.error('Usage: node scripts/install-vault-kit.mjs "<vault>/Zombie Hand"');
  process.exit(2);
}
const folder = resolve(target);
const stats = await lstat(folder).catch(() => undefined);
if (!stats?.isDirectory()) {
  console.error(`Not a folder: ${folder}`);
  process.exit(2);
}
const entries = await readdir(folder);
if (entries.some((name) => !name.startsWith('.')) && !entries.includes('captures')) {
  console.error(
    `${folder} has files but no captures/ folder, so it doesn't look like the Zombie Hand folder. Nothing was copied.`,
  );
  process.exit(2);
}

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

const outcomes = { added: [], current: [], kept: [] };
for await (const source of files(kit)) {
  const name = relative(kit, source).replace(/^claude(?=[/\\])/, '.claude');
  const destination = join(folder, name);
  const bytes = await readFile(source);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(destination, bytes, { flag: 'wx' });
    outcomes.added.push(name);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(destination).catch(() => undefined);
    (existing?.equals(bytes) ? outcomes.current : outcomes.kept).push(name);
  }
}

for (const name of outcomes.added) console.log(`added    ${name}`);
for (const name of outcomes.current) console.log(`current  ${name}`);
for (const name of outcomes.kept) console.log(`kept     ${name} (yours differs; left as it is)`);
console.log(`
Next, from that folder:
  cd ${JSON.stringify(folder)}
  claude
Accept the trust prompt (it lists the wiki-only rules), then type /ingest.`);
