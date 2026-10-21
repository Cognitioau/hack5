import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '..', '..');
const installer = join(repository, 'scripts', 'install-vault-kit.mjs');

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hack5-vault-kit-')));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const install = (folder: string) =>
  spawnSync(process.execPath, [installer, folder], { encoding: 'utf8' });

/** A capture folder with the kit installed, as a person would have it. */
function vault(): string {
  const folder = join(scratch, 'vault', 'Zombie Hand');
  mkdirSync(join(folder, 'captures'), { recursive: true });
  writeFileSync(join(folder, 'captures', 'grave.md'), 'A capture.\n');
  expect(install(folder).status).toBe(0);
  return folder;
}

describe('the wiki-only hook', () => {
  const ask = (folder: string, input: unknown, raw = false) =>
    spawnSync(process.execPath, [join(folder, '.claude', 'hooks', 'wiki-only.mjs')], {
      input: raw ? String(input) : JSON.stringify(input),
      encoding: 'utf8',
    });
  const edit = (folder: string, file_path: string, cwd = folder) =>
    ask(folder, { tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd }).status;

  it('lets through files inside wiki/, before and after the folder exists', () => {
    const folder = vault();
    expect(edit(folder, join(folder, 'wiki', 'index.md'))).toBe(0);
    mkdirSync(join(folder, 'wiki'));
    expect(edit(folder, join(folder, 'wiki', 'index.md'))).toBe(0);
    expect(edit(folder, join(folder, 'wiki', 'concepts', 'deep', 'page.md'))).toBe(0);
    expect(edit(folder, 'wiki/relative.md')).toBe(0);
    expect(
      ask(folder, {
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: join(folder, 'wiki', 'n.ipynb') },
        cwd: folder,
      }).status,
    ).toBe(0);
  });

  it('blocks every other place, however the path is spelled', () => {
    const folder = vault();
    mkdirSync(join(folder, 'wiki'));
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    for (const path of [
      join(folder, 'captures', 'grave.md'),
      join(folder, 'root.md'),
      join(folder, 'AGENTS.md'),
      join(folder, '.claude', 'settings.json'),
      join(folder, '.claude', 'hooks', 'wiki-only.mjs'),
      join(folder, 'wiki'),
      `${join(folder, 'wiki')}/../captures/grave.md`,
      'wiki/../captures/new.md',
      '../outside.md',
      join(outside, 'x.md'),
      join(folder, 'wikipedia.md'),
      join(folder, 'wiki-notes', 'x.md'),
    ])
      expect(edit(folder, path), path).toBe(2);
  });

  it('follows symlinks inside wiki/ to where a write would land', () => {
    const folder = vault();
    mkdirSync(join(folder, 'wiki'));
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    symlinkSync(join(folder, 'captures'), join(folder, 'wiki', 'into-captures'));
    symlinkSync(outside, join(folder, 'wiki', 'out'));
    symlinkSync(join(outside, 'not-yet.md'), join(folder, 'wiki', 'dangling.md'));
    expect(edit(folder, join(folder, 'wiki', 'into-captures', 'grave.md'))).toBe(2);
    expect(edit(folder, join(folder, 'wiki', 'out', 'new.md'))).toBe(2);
    expect(edit(folder, join(folder, 'wiki', 'dangling.md'))).toBe(2);
    expect(existsSync(join(outside, 'not-yet.md'))).toBe(false);
  });

  it('blocks a call it cannot read', () => {
    const folder = vault();
    expect(ask(folder, 'not json', true).status).toBe(2);
    expect(ask(folder, { tool_name: 'Write', tool_input: {} }).status).toBe(2);
    expect(ask(folder, { tool_name: 'Write', tool_input: { file_path: 42 } }).status).toBe(2);
    expect(ask(folder, 'not json', true).stderr).toContain('Only files inside wiki/');
  });
});

describe('the kit settings', () => {
  const settings = JSON.parse(
    readFileSync(join(repository, 'vault-kit', 'claude', 'settings.json'), 'utf8'),
  );

  it('run the hook before every file-changing tool, and block when it cannot run', () => {
    const [entry] = settings.hooks.PreToolUse;
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(new RegExp(entry.matcher).test(tool), tool).toBe(true);
    expect(entry.hooks).toEqual([
      expect.objectContaining({
        type: 'command',
        command: 'node',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder.
        args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/wiki-only.mjs'],
        onFailure: 'block',
      }),
    ]);
  });

  it('fence reads to the folder and grant no blanket tool', () => {
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.permissions.allow).toEqual(['Read(./**)', 'Edit(./wiki/**)']);
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Monitor', 'NotebookEdit'])
      expect(settings.permissions.deny).toContain(tool);
    for (const skill of readdirSync(join(repository, 'vault-kit', 'claude', 'skills')))
      expect(
        readFileSync(join(repository, 'vault-kit', 'claude', 'skills', skill, 'SKILL.md'), 'utf8'),
        skill,
      ).toMatch(/^allowed-tools: Read\(\.\/\*\*\) Edit\(\.\/wiki\/\*\*\)$/mu);
  });
});

describe('the kit installer', () => {
  it('installs the settings, hook and skills into a capture folder', () => {
    const folder = join(scratch, 'Zombie Hand');
    mkdirSync(join(folder, 'captures'), { recursive: true });
    const run = install(folder);
    expect(run.status).toBe(0);
    for (const file of [
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      '.claude/hooks/wiki-only.mjs',
      '.claude/skills/ingest/SKILL.md',
    ])
      expect(existsSync(join(folder, file)), file).toBe(true);
    expect(run.stdout).toContain('/ingest');
    expect(install(folder).status).toBe(0);
  });

  it('says the wiki-only rules are missing when the folder keeps its own settings', () => {
    const folder = join(scratch, 'Zombie Hand');
    mkdirSync(join(folder, '.claude'), { recursive: true });
    mkdirSync(join(folder, 'captures'));
    writeFileSync(join(folder, '.claude', 'settings.json'), '{}\n');
    const run = install(folder);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not confined');
    expect(run.stdout).not.toContain('trust prompt');
    expect(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')).toBe('{}\n');
  });

  it('writes nothing through a symlink out of the folder', () => {
    const folder = join(scratch, 'Zombie Hand');
    const elsewhere = join(scratch, 'elsewhere');
    mkdirSync(join(folder, 'captures'), { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(folder, '.claude'));
    const run = install(folder);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('symlink');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(folder, 'AGENTS.md'))).toBe(false);
  });

  it('refuses a folder that is not a capture folder', () => {
    const folder = join(scratch, 'Notes');
    mkdirSync(folder);
    writeFileSync(join(folder, 'diary.md'), 'Private.\n');
    expect(install(folder).status).toBe(2);
    expect(readdirSync(folder)).toEqual(['diary.md']);
  });
});
