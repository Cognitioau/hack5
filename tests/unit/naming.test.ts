import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '..', '..');

/** Every file under a folder, by walking it, so a new file is checked without being listed. */
function walk(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)],
  );
}

/** What the extension ships and a person reads: its code, pages, manifest and vault kit. */
const shipped = () => [
  ...walk(join(repository, 'src')).filter((path) => path.endsWith('.ts')),
  ...readdirSync(repository)
    .filter((name) => name.endsWith('.html') || name === 'manifest.json')
    .map((name) => join(repository, name)),
  ...walk(join(repository, 'vault-kit')),
  join(repository, 'scripts', 'install-vault-kit.mjs'),
  join(repository, 'scripts', 'package.mjs'),
];

/** The old product name, as a person would read it. */
const oldName = /Zombie Hand|ZOMBIE HAND/;

describe('the product is named Zombie Brain', () => {
  it('nowhere in what the extension ships says Zombie Hand', () => {
    const files = shipped();
    // The pages, the manifest, the code and the kit were all found (57 files when written).
    expect(files.length).toBeGreaterThan(50);
    for (const page of ['options.html', 'popup.html', 'graveyard.html', 'manifest.json'])
      expect(files).toContain(join(repository, page));
    const named = files
      .filter((path) => oldName.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repository, path));
    expect(named).toEqual([]);
  });

  it('calls itself Zombie Brain in Chrome and starts with a Zombie Brain folder', () => {
    const manifest = JSON.parse(readFileSync(join(repository, 'manifest.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe('Zombie Brain');
    expect(readFileSync(join(repository, 'options.html'), 'utf8')).toContain(
      'id="folder" type="text" required value="Zombie Brain"',
    );
    expect(readFileSync(join(repository, 'src/core/contracts/index.ts'), 'utf8')).toContain(
      "folder: 'Zombie Brain',",
    );
  });

  // Saved data is found by these names, so the rename leaves them: the device's captures,
  // the notes already in a vault, exported files, and an earlier version's page overlay.
  it.each([
    ['src/adapters/persistence/indexed-db.ts', "name = 'zombie-hand-v1'"],
    ['src/adapters/persistence/vault.ts', "const marker = 'hack5:zombie-hand';"],
    ['src/adapters/persistence/vault.ts', 'zombie_hand: marker,'],
    ['src/bootstrap/graveyard.ts', "format: 'zombie-hand-export',"],
    ['src/bootstrap/content.ts', "'[data-zombie-hand-ui]'"],
    ['src/features/gaze/diagnostics.ts', "'zombie-hand.gaze-diagnostics'"],
  ])('keeps the data name in %s: %s', (path, kept) => {
    expect(readFileSync(join(repository, path), 'utf8')).toContain(kept);
  });
});
