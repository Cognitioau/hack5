import type { AppResponse } from '../core/contracts';
import { command } from '../adapters/browser/client';
import { universalPageOrigins } from '../adapters/browser/activation';
import { element } from '../ui/common';

type State = Extract<AppResponse, { ok: true }>;
const grabButtons = [
  element<HTMLButtonElement>('grab-selection'),
  element<HTMLButtonElement>('grab-page'),
];
const toggle = element<HTMLButtonElement>('activation');
let activation: NonNullable<State['activation']> = 'manual';

function say(text: string): void {
  const box = element('message');
  box.textContent = text;
  box.hidden = text.length === 0;
}
const failed = (error: unknown): void =>
  say(error instanceof Error ? error.message : 'That did not work. Try again.');

function render(state: State): void {
  activation = state.activation ?? 'manual';
  const mode = element('mode');
  mode.dataset.mode = activation;
  mode.textContent =
    activation === 'universal'
      ? 'On everywhere'
      : activation === 'paused'
        ? 'Paused'
        : 'On request';
  toggle.textContent = activation === 'universal' ? 'Pause everywhere' : 'Turn on everywhere';
  toggle.disabled = false;
  for (const button of grabButtons) button.disabled = activation === 'paused';
  if (activation === 'paused') say('Paused everywhere. Turn the hand on to grab.');
  const kept = (state.captures ?? []).filter(
    (capture) => capture.lifecycle === 'active' && capture.persistence !== 'saved-vault',
  ).length;
  const vault = element('vault');
  if (state.hasKey) {
    vault.textContent = kept
      ? `Vault connected. ${kept} capture${kept === 1 ? '' : 's'} waiting to sync.`
      : 'Vault connected. Grabs are buried in Obsidian.';
    return;
  }
  const link = document.createElement('a');
  link.href = 'options.html';
  link.target = '_blank';
  link.textContent = 'Connect vault';
  vault.replaceChildren(
    `No vault yet${kept ? `; ${kept} capture${kept === 1 ? ' is' : 's are'} kept on this device` : ''}. `,
    link,
  );
}

async function load(): Promise<void> {
  render(await command({ v: 1, type: 'GET_STATE' }));
}

for (const [button, kind] of [
  [grabButtons[0], 'selection'],
  [grabButtons[1], 'page'],
] as const)
  button?.addEventListener('click', () => {
    for (const each of grabButtons) each.disabled = true;
    say('');
    // The page plays the grab; the popup gets out of its way once it has begun.
    void command({ v: 1, type: 'GRAB_ACTIVE_TAB', kind }).then(
      () => window.close(),
      (error: unknown) => {
        failed(error);
        for (const each of grabButtons) each.disabled = activation === 'paused';
      },
    );
  });

toggle.addEventListener('click', () => {
  toggle.disabled = true;
  say('');
  if (activation === 'universal') {
    void command({ v: 1, type: 'SET_ACTIVATION', enabled: false })
      .then(load)
      .catch(failed)
      .finally(() => {
        toggle.disabled = false;
      });
    return;
  }
  // Start the browser prompt inside this click. Should the prompt close the
  // popup, the background finishes the activation when Chrome reports the grant.
  const intent = command({ v: 1, type: 'BEGIN_ACTIVATION' });
  const permission = chrome.permissions.request({ origins: [...universalPageOrigins] });
  void (async () => {
    const [request, granted] = await Promise.all([intent, permission]);
    if (!granted) throw new Error('Site access was not granted, so the hand stays as it was.');
    if (!request.activationRequest) throw new Error('Could not start activation. Try again.');
    await command({
      v: 1,
      type: 'SET_ACTIVATION',
      enabled: true,
      requestId: request.activationRequest,
    });
    await load();
  })()
    .catch(failed)
    .finally(() => {
      toggle.disabled = false;
    });
});

void load().catch(failed);
