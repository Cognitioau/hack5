// Refuses any file change outside this folder's wiki/, whatever other settings
// allow. Claude Code runs it before each Edit, Write or NotebookEdit; exit 2
// blocks the call even where your own settings would let it through, and the
// kit's settings block the call if this script cannot run at all.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

let input = '';
for await (const chunk of process.stdin) input += chunk;
let inWiki = false;
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
} catch {
  inWiki = false;
}
if (!inWiki) {
  process.stderr.write(
    'Only files inside wiki/ may be changed here. Captures, attachments, settings and everything outside this folder stay as they are.\n',
  );
  process.exit(2);
}
