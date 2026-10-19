// Offline evaluation of exported gaze-lab session diagnostics.
//
//   node scripts/gaze-eval.mjs <diagnostics.json> [more.json …] [--json]
//
// Re-runs the lab's own TypeScript (bundled in memory with esbuild, nothing written to disk) on
// each file: per model variant, the leave-one-target-out error on the nine calibration targets and
// the error on the five separate checks, plus a settling-time sweep replayed from recorded frames.
// The files hold derived eye measurements only; this script reads them locally and sends nothing.
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((arg) => !arg.startsWith('--'));
if (!files.length) {
  console.error('Usage: node scripts/gaze-eval.mjs <diagnostics.json> [more.json …] [--json]');
  process.exit(2);
}

const bundle = await build({
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  stdin: {
    contents: `export { evaluateSession } from './src/features/gaze/evaluate.ts';
      export { parseDiagnostics } from './src/features/gaze/diagnostics.ts';
      export { VARIANT_LABELS } from './src/features/gaze/calibration.ts';`,
    resolveDir: root,
    sourcefile: 'gaze-eval-entry.ts',
    loader: 'ts',
  },
});
const { evaluateSession, parseDiagnostics, VARIANT_LABELS } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const px = (value) => (Number.isFinite(value) ? String(Math.round(value)) : '—');
const pair = (summary) =>
  summary ? `${px(summary.medianPixels)} / ${px(summary.maximumPixels)}` : '—';
const label = (variant) =>
  variant === 'legacy'
    ? 'legacy (approx.: old λ0.5 all-feature fit)'
    : `${variant} (${VARIANT_LABELS[variant]})`;
const pad = (text, width) => String(text).padEnd(width);

const reports = [];
for (const file of files) {
  let session;
  try {
    session = parseDiagnostics(JSON.parse(await readFile(resolve(file), 'utf8')));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    continue;
  }
  const report = evaluateSession(session);
  reports.push({ file: basename(file), report });
  if (json) continue;
  const { viewport, holdout } = session;
  console.log(`\n== ${basename(file)}`);
  console.log(
    `Recorded ${session.createdAt}, viewport ${viewport.width}×${viewport.height} @${viewport.pixelRatio}x. Live choice: ${session.model.variant} λ${session.model.lambda}; checks median ${px(holdout.medianPixels)} px, largest ${px(holdout.maximumPixels)} px.`,
  );
  console.log(
    report.replayMatches
      ? 'Replay of recorded frames reproduces every live capture.'
      : 'WARNING: replaying recorded frames did not reproduce every live capture (code or settings changed since recording).',
  );
  console.log(
    `\n${pad('variant', 50)}${pad('λ', 7)}${pad('LOTO-CV median / max px', 26)}checks median / max px`,
  );
  for (const row of report.variants)
    console.log(
      `${pad(label(row.variant), 50)}${pad(Number.isFinite(row.lambda) ? row.lambda : '—', 7)}${pad(pair(row.crossValidation), 26)}${pair(row.validation)}`,
    );
  console.log(`\nCurrent code would select: ${report.selected.variant} λ${report.selected.lambda}`);
  const sweepTable = (title, rows) => {
    console.log(
      `\n${title}\n${pad('settle ms', 11)}${pad('window', 8)}${pad('captured', 10)}${pad('unstable', 10)}${pad('selected', 22)}checks median / max px`,
    );
    for (const row of rows)
      console.log(
        `${pad(row.settleMs, 11)}${pad(row.stableSamples, 8)}${pad(row.capturedTargets, 10)}${pad(row.unstableTargets, 10)}${pad(row.selected ? `${row.selected.variant} λ${row.selected.lambda}` : '—', 22)}${pair(row.validation)}`,
      );
  };
  sweepTable(
    'Settling sweep (replayed; needs frames recorded after capture for long values):',
    report.settleSweep,
  );
  sweepTable('Stable-window sweep (frames per target):', report.windowSweep);
}

if (json) console.log(JSON.stringify(reports, null, 2));
else if (reports.length > 1) {
  console.log(
    `\n== ${reports.length} sessions: median across sessions of each variant's check median`,
  );
  const variants = reports[0]?.report.variants.map((row) => row.variant) ?? [];
  for (const variant of variants) {
    const medians = reports
      .map(
        ({ report }) =>
          report.variants.find((row) => row.variant === variant)?.validation?.medianPixels,
      )
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const middle = Math.floor(medians.length / 2);
    const value =
      medians.length % 2 ? medians[middle] : (medians[middle - 1] + medians[middle]) / 2;
    console.log(
      `${pad(label(variant), 50)}${medians.length ? `${px(value)} px (${medians.length} sessions)` : '—'}`,
    );
  }
}
