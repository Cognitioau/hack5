import type { PublicCapture, SearchResult } from '../core/contracts';
import { command } from '../adapters/browser/client';
import { busy, element, notice } from '../ui/common';

let captures: PublicCapture[] = [];
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function card(capture: PublicCapture, result?: SearchResult) {
  const article = make('article', undefined, 'capture-card');
  const header = make('header');
  header.append(make('h2', capture.candidate.title));
  const status =
    capture.lifecycle === 'archived'
      ? 'Archived'
      : capture.persistence === 'saved-vault'
        ? 'Saved to Obsidian'
        : capture.persistence === 'queued-local'
          ? 'Queued locally'
          : capture.persistence === 'uncertain'
            ? 'Save uncertain'
            : capture.persistence === 'conflict'
              ? 'Needs reconciliation'
              : 'Needs attention';
  header.append(
    make('span', status, `pill ${capture.persistence !== 'saved-vault' ? 'pending' : ''}`),
  );
  article.append(header);
  const metadata = make('div', undefined, 'capture-meta');
  metadata.append(
    make('span', capture.candidate.kind.toUpperCase()),
    make('span', new Date(capture.createdAt).toLocaleString()),
    make(
      'span',
      capture.preservation === 'file'
        ? 'LOCAL ATTACHMENT'
        : capture.preservation === 'screenshot'
          ? 'VISIBLE CROP'
          : capture.preservation === 'link'
            ? 'SOURCE LINK'
            : 'TEXT',
    ),
  );
  if (result)
    metadata.append(make('span', result.mode === 'semantic' ? 'SEMANTIC MATCH' : 'KEYWORD MATCH'));
  article.append(
    metadata,
    make(
      'blockquote',
      (result?.excerpt ?? capture.candidate.text ?? '').slice(0, 2000) ||
        'The source reference is saved.',
    ),
  );
  if (capture.candidate.video)
    article.append(
      make(
        'p',
        `Transcript: ${capture.candidate.video.transcript.status} · ${capture.candidate.video.transcript.cues.length} captured cues`,
        'hint',
      ),
    );
  if (capture.candidate.video?.transcript.provenance === 'import')
    article.append(make('p', 'Transcript supplied by manual import.', 'hint'));
  if (capture.lastError) article.append(make('p', capture.lastError, 'hint'));
  if (capture.indexState === 'failed')
    article.append(
      make('p', 'Semantic indexing unavailable. Keyword search remains available.', 'hint'),
    );
  const actions = make('div', undefined, 'actions');
  const source = make('a', 'Return to source ↗', 'button');
  source.href = result?.sourceUrl ?? capture.candidate.url;
  source.target = '_blank';
  source.rel = 'noopener noreferrer';
  actions.append(source);
  const archive = make(
    'button',
    capture.lifecycle === 'archived' ? 'Rebury' : 'Spit back',
    'subtle',
  );
  archive.addEventListener(
    'click',
    () =>
      void busy(archive, async () => {
        await command({
          v: 1,
          type: 'SET_LIFECYCLE',
          captureId: capture.id,
          lifecycle: capture.lifecycle === 'archived' ? 'active' : 'archived',
        });
        await load();
      }),
  );
  actions.append(archive);
  article.append(actions);
  return article;
}
function render(results?: SearchResult[]) {
  if (!results) {
    element<HTMLInputElement>('query').value = '';
    element('search-mode').textContent =
      'Pending and failed captures stay here until you resolve them.';
  }
  const target = element('captures');
  target.replaceChildren();
  const archived = element<HTMLInputElement>('show-archived').checked;
  const records = results
    ? results.map((result) => ({ capture: result.capture, result }))
    : captures
        .filter((capture) => archived || capture.lifecycle === 'active')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((capture) => ({ capture, result: undefined }));
  element('capture-count').textContent =
    `${captures.filter((capture) => capture.lifecycle === 'active').length} ACTIVE THOUGHTS`;
  if (!records.length) {
    const empty = make('div', undefined, 'empty');
    empty.append(
      make('div', '⌑', 'empty-art'),
      make('h2', results ? 'Nothing surfaced yet.' : 'Your graveyard is quiet.'),
      make(
        'p',
        results
          ? 'Try a different phrase. Search includes active, vault-confirmed captures.'
          : 'Open a page, click the Zombie Hand toolbar button, and capture your first thought.',
      ),
    );
    target.append(empty);
  }
  for (const { capture, result } of records) target.append(card(capture, result));
}
async function load() {
  const state = await command({ v: 1, type: 'GET_STATE' });
  captures = state.captures ?? [];
  if (!__CORE_ONLY__) element('transcript-import').hidden = !state.settings?.features.youtube;
  render();
}
element<HTMLFormElement>('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = element<HTMLFormElement>('search-form').querySelector<HTMLButtonElement>('button');
  if (button)
    void busy(button, async () => {
      const query = element<HTMLInputElement>('query').value.trim();
      if (!query) {
        await load();
        return;
      }
      const response = await command({ v: 1, type: 'SEARCH', query });
      render(response.results ?? []);
      element('search-mode').textContent =
        'Results use saved active evidence. Each match identifies semantic or keyword search.';
    });
});
element('show-archived').addEventListener('change', () => render());
element<HTMLButtonElement>('refresh').addEventListener(
  'click',
  () => void busy(element('refresh'), load),
);
element<HTMLButtonElement>('retry').addEventListener(
  'click',
  () =>
    void busy(element('retry'), async () => {
      notice('Retrying saved operations…');
      const response = await command({ v: 1, type: 'RETRY' });
      notice(response.message ?? 'Retried', 'success');
      await load();
    }),
);
element<HTMLButtonElement>('import').addEventListener(
  'click',
  () =>
    void busy(element('import'), async () => {
      notice('Checking vault records and original evidence…');
      const response = await command({ v: 1, type: 'IMPORT_VAULT' });
      notice(response.message ?? 'Recovery complete', 'success');
      await load();
    }),
);
element<HTMLButtonElement>('export').addEventListener('click', () => {
  void busy(element('export'), async () => {
    const response = await command({ v: 1, type: 'EXPORT_RECORDS' });
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: 'zombie-hand-export',
              exportVersion: 1,
              records: response.exportRecords ?? [],
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const link = make('a');
    link.href = url;
    link.download = 'zombie-hand-captures.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice(
      'Exported original records and attachment bytes. Unsupported future records are preserved without alteration.',
      'success',
    );
  });
});
void load().catch((error: unknown) =>
  notice(error instanceof Error ? error.message : 'Could not load captures', 'error'),
);
if (!__CORE_ONLY__) {
  const form = element<HTMLFormElement>('transcript-form');
  let pendingImport: { payload: string; operationId: string } | undefined;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (!button) return;
    void busy(button, async () => {
      const values = {
        url: element<HTMLInputElement>('transcript-url').value.trim(),
        title: element<HTMLInputElement>('transcript-title').value.trim(),
        seconds: Number(element<HTMLInputElement>('transcript-seconds').value),
        text: element<HTMLTextAreaElement>('transcript-text').value,
      };
      const payload = JSON.stringify(values);
      if (pendingImport?.payload !== payload)
        pendingImport = { payload, operationId: crypto.randomUUID() };
      const response = await command({
        v: 1,
        type: 'IMPORT_TRANSCRIPT',
        ...values,
        operationId: pendingImport.operationId,
      });
      notice(response.message ?? 'Transcript import queued.', 'success');
      form.reset();
      pendingImport = undefined;
      await load();
    });
  });
}
