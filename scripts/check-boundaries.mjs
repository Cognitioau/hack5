import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function files(directory) {
  return (
    await Promise.all(
      (
        await readdir(directory, { withFileTypes: true })
      ).map((entry) =>
        entry.isDirectory()
          ? files(resolve(directory, entry.name))
          : [resolve(directory, entry.name)],
      ),
    )
  ).flat();
}
const errors = [];
const allFiles = (await files(resolve(root, 'src'))).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
);
for (const file of allFiles) {
  const name = relative(root, file).replaceAll('\\', '/');
  const segments = name.split('/');
  const layer = segments[1];
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const reject = (message) => errors.push(`${name}: ${message}`);
  function importCheck(specifier) {
    if (!specifier.startsWith('.')) {
      if (layer === 'core' && specifier !== 'zod')
        reject(`core cannot import package ${specifier}`);
      if (layer === 'application') reject(`application cannot import package ${specifier}`);
      if (layer === 'features') reject(`feature cannot import package ${specifier}; inject a port`);
      return;
    }
    const target = relative(resolve(root, 'src'), resolve(dirname(file), specifier))
      .replaceAll('\\', '/')
      .split('/');
    if (target[0] === '..') reject(`import escapes src: ${specifier}`);
    if (layer === 'core' && target[0] !== 'core') reject(`core imports outer layer ${specifier}`);
    if (layer === 'application' && !['application', 'core'].includes(target[0]))
      reject(`application imports implementation ${specifier}`);
    if (layer !== 'bootstrap' && target[0] === 'bootstrap')
      reject(`only bootstrap may import a composition root`);
    if (layer === 'features' && !['core', 'features', 'ui'].includes(target[0]))
      reject(`feature imports privileged implementation ${specifier}`);
    if (layer === 'features' && target[0] === 'features' && target[1] !== segments[2])
      reject(`feature imports sibling ${specifier}`);
    if (layer === 'ui' && !['core', 'ui'].includes(target[0]))
      reject(`UI imports implementation ${specifier}`);
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      importCheck(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
        reject('computed dynamic imports are forbidden');
      else importCheck(node.arguments[0].text);
    }
    if (
      ['core', 'application', 'features'].includes(layer) &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fetch' &&
      ts.isIdentifier(node.expression.expression) &&
      ['globalThis', 'window', 'self'].includes(node.expression.expression.text)
    )
      reject('global fetch must stay behind an adapter port');
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      ['eval', 'Function'].includes(node.expression.text)
    )
      reject('runtime code evaluation is forbidden');
    if (ts.isIdentifier(node)) {
      const privileged = [
        'chrome',
        'indexedDB',
        'localStorage',
        'sessionStorage',
        'XMLHttpRequest',
        'WebSocket',
      ];
      if (['core', 'application', 'features'].includes(layer) && privileged.includes(node.text))
        reject(`privileged ${node.text} must stay behind an adapter port`);
      if (
        ['core', 'application', 'features'].includes(layer) &&
        node.text === 'fetch' &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node
      )
        reject('global fetch must stay behind an adapter port');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (errors.length)
  throw new Error(`Import/capability boundary violations:\n${[...new Set(errors)].join('\n')}`);
console.log(
  `Verified layer and privileged-capability boundaries in ${allFiles.length} TypeScript files.`,
);
