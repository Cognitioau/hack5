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

// The extension's own files are checked as built, by scripts/check-package.mjs. The vault kit
// never goes through the build: its installer copies it into a person's vault and prints to them.
describe('the vault kit is named for Zombie Brain', () => {
  it('nowhere in the kit or its installer says Zombie Hand', () => {
    const files = [
      ...walk(join(repository, 'vault-kit')),
      join(repository, 'scripts', 'install-vault-kit.mjs'),
    ];
    // The kit's guidance, skills, settings and hook were all found (8 files when written).
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(join(repository, 'vault-kit', 'AGENTS.md'));
    const named = files
      .filter((path) => /zombie\s+hand/i.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repository, path));
    expect(named).toEqual([]);
  });
});
