// Refuses any file change outside this folder's wiki/, whatever other settings
// allow, and any new wiki line that Obsidian would hide, load from the web or
// run. Claude Code runs it before each Edit, Write or NotebookEdit; exit 2
// blocks the call even where your own settings would let it through, and the
// kit's settings block the call if this script cannot run at all.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file sits in <folder>/.claude/hooks/.
const folder = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..', '..');

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Where a write to this path lands, following every symlink on the way; null if unknowable. */
function landing(path) {
  const missing = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...missing);
    } catch {
      // Something is there but does not resolve, such as a link to nowhere:
      // a write would follow it to wherever it points.
      if (exists(at)) return null;
      const parent = dirname(at);
      if (parent === at) return null;
      missing.unshift(basename(at));
      at = parent;
    }
  }
}

/**
 * Languages a code fence may name. They only colour the code, where a plugin
 * may run a block it claims, as Dataview runs `dataviewjs`.
 */
const FENCE_LANGUAGES = new Set(
  'bash c cpp cs csharp css diff go html ini java javascript js json kotlin md markdown php plain powershell py python r rb ruby rust sh shell sql swift text toml ts txt typescript xml yaml yml zsh'.split(
    ' ',
  ),
);
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/uy;
const EMAIL =
  /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/uy;
const at = (pattern, line, index) => {
  pattern.lastIndex = index;
  return pattern.test(line);
};

/**
 * What in one line Obsidian would hide, fetch or run, wherever it sits, code
 * included: HTML (comments too), a Markdown image, a `%%` comment, an embed of a
 * web address, a Templater command, a Dataview query or a fence a plugin may
 * run. A web or mail address in angle brackets is a link, and a character after
 * a backslash shows as written, except to Templater, which reads the raw file.
 */
function trouble(line) {
  if (line.includes('<%')) return 'a Templater command (<%)';
  // Dataview's default prefixes, `= …` and `$= …`, wherever a code span could open.
  if (/`\s*\$?=/u.test(line)) return 'a Dataview query in inline code';
  for (const [, language] of line.matchAll(/(?:`{3,}|~{3,})\s*([^\s`~]*)/gu))
    if (language && !FENCE_LANGUAGES.has(language.toLowerCase()))
      return `a code fence named ${JSON.stringify(language)}`;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '\\') index++;
    else if (character === '<') {
      if (
        /[A-Za-z/!?]/u.test(line[index + 1] ?? '') &&
        !at(AUTOLINK, line, index) &&
        !at(EMAIL, line, index)
      )
        return 'HTML';
    } else if (line.startsWith('![[', index)) {
      const end = line.indexOf(']]', index);
      if (line.slice(index + 3, end < 0 ? undefined : end).includes('://'))
        return 'an embed of a web address';
    } else if (line.startsWith('![', index)) return 'a Markdown image';
    else if (line.startsWith('%%', index)) return 'a %% comment';
  }
  return null;
}

const lines = (text) => text.split(/\r\n|\r|\n/u);

/** The lines of `after` beyond the copies of them `before` already holds. */
function added(before, after) {
  const held = new Map();
  for (const line of lines(before)) held.set(line, (held.get(line) ?? 0) + 1);
  return lines(after).filter((line) => {
    const left = held.get(line) ?? 0;
    held.set(line, left - 1);
    return left <= 0;
  });
}

/**
 * The lines a Write, Edit or MultiEdit would add to the file, beyond those it
 * already holds, so a line a person wrote stays theirs. When an edit's text is
 * not in the file Claude Code refuses the call itself, and every line of the
 * new text counts. Null when the call's shape is unknown.
 */
function written(tool, current) {
  if (typeof tool.content === 'string') return added(current, tool.content);
  const edits = Array.isArray(tool.edits) ? tool.edits : [tool];
  if (
    !edits.every(
      (edit) => typeof edit?.old_string === 'string' && typeof edit.new_string === 'string',
    )
  )
    return null;
  let text = current;
  for (const { old_string: from, new_string: to, replace_all: all } of edits) {
    if (from === '' ? text !== '' : !text.includes(from))
      return edits.flatMap((edit) => lines(edit.new_string));
    text = all === true ? text.split(from).join(to) : text.replace(from, () => to);
  }
  return added(current, text);
}

/** Why a change to this wiki file is refused, or '' when it may go ahead. */
function refusal(tool, lands) {
  if (extname(lands).toLowerCase() !== '.md')
    return 'Wiki pages are Markdown files ending in .md, so nothing else is written in wiki/: a canvas or other file Obsidian opens could load from the web.\n';
  let current = '';
  try {
    current = readFileSync(lands, 'utf8');
  } catch {
    // A new file, or one that cannot be read: every line counts as new.
  }
  const change = written(tool, current);
  if (!change) return 'The hook could not read this change, so it is refused.\n';
  for (const line of change) {
    const kind = trouble(line);
    if (kind)
      return `This change writes ${kind} into a wiki page: ${JSON.stringify(line.slice(0, 120))}. Wiki pages show everything they hold, load nothing from the web and run nothing, in code too: no HTML or <!-- --> comments, no %% comments, no image or embed from a web address (embed a saved attachment with ![[…]]), no Templater <% command, no Dataview query in inline code, and code fences named only ${[...FENCE_LANGUAGES].join(', ')}, or nothing. Where a capture's words hold such text, write it so it shows as written: \\%\\%, \\![, &lt;tag&gt;, &lt;%. Code that needs it stays in its capture; link to that instead.\n`;
  }
  return '';
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
let inWiki = false;
let refused = '';
try {
  const { tool_input: tool, cwd } = JSON.parse(input);
  const target = tool?.file_path ?? tool?.notebook_path;
  const wiki = landing(join(folder, 'wiki'));
  const lands =
    typeof target === 'string' && target
      ? landing(resolve(typeof cwd === 'string' ? cwd : folder, target))
      : null;
  const inside = wiki && lands ? relative(wiki, lands) : '';
  inWiki =
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  if (inWiki) refused = refusal(tool, lands);
} catch {
  inWiki = false;
}
if (!inWiki) {
  process.stderr.write(
    'Only files inside wiki/ may be changed here. Captures, attachments, settings and everything outside this folder stay as they are.\n',
  );
  process.exit(2);
}
if (refused) {
  process.stderr.write(refused);
  process.exit(2);
}
