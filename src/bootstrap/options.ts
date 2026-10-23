import {
  defaultSettings,
  type AppResponse,
  type Settings,
  type VaultStatus,
} from '../core/contracts';
import { command } from '../adapters/browser/client';
import { universalPageOrigins } from '../adapters/browser/activation';
import { originPattern } from '../adapters/browser/settings';
import { publicMediaUrl } from '../core/domain/security';
import { busy, element, notice } from '../ui/common';

type State = Extract<AppResponse, { ok: true }>;
const input = (id: string) => element<HTMLInputElement>(id);
let settings: Settings = structuredClone(defaultSettings);
let activation: State['activation'] = 'manual';
/** Save, Test and Forget each change the vault connection, so only one runs at a time. */
const vaultButtons = () => [
  ...element('settings-form').querySelectorAll<HTMLButtonElement>('.actions button'),
];
let testing = false;
let vaultRefresh: ReturnType<typeof setTimeout> | undefined;
/** The vault status the page last showed. Save reads it to know whether access was off. */
let shownStatus: VaultStatus | undefined;
/** How long the status follows a waiting count that has stopped moving. */
const followMs = 60_000;
/** The waiting count at the last read, and when, by the page's clock, it last changed. */
let lastWaiting: number | undefined;
let waitingSince = 0;
/** A Save, the end of a Test or coming back to the tab follows the queue afresh. */
function followQueue(): void {
  lastWaiting = undefined;
}
/** The vault connection beside Save, as the background reports it. Plain text only. */
function renderVault(state: State): void {
  const status = state.vaultStatus ?? { state: 'none', remembered: false };
  shownStatus = status;
  const saved = state.settings ?? settings;
  // Captures still to reach the vault, counted as the popup counts them.
  const waiting = (state.captures ?? []).filter(
    (capture) => capture.lifecycle === 'active' && capture.persistence !== 'saved-vault',
  ).length;
  const box = element('vault-status');
  const line = element('vault-state');
  clearTimeout(vaultRefresh);
  if (testing) {
    box.dataset.state = 'testing';
    line.textContent = 'Testing the vault…';
  } else if (status.state === 'syncing') {
    const queue = waiting ? ` ${waiting} capture${waiting === 1 ? '' : 's'} waiting to sync.` : '';
    // Sync is on, but a failed test says the vault may not be taking grabs: a warning.
    box.dataset.state = status.error ? 'failing' : 'syncing';
    line.textContent = status.error
      ? `Sync is on for ${saved.endpoint}, but the last vault test failed: ${status.error}${queue}`
      : `Connected to ${saved.endpoint}. Grabs save to the “${saved.folder}” folder.${queue}`;
    // The background drains the queue after a passing test; follow the count down while
    // the page is in view. Each read lists every capture, so a count that has not moved for
    // a minute (a grab that cannot sync) stops it until a Save, a Test or a return; a slow
    // send that moves the count keeps it going.
    if (waiting !== lastWaiting) {
      lastWaiting = waiting;
      waitingSince = performance.now();
    }
    if (
      waiting &&
      performance.now() - waitingSince < followMs &&
      document.visibilityState === 'visible'
    )
      vaultRefresh = setTimeout(() => void refreshVault(), 3000);
  } else if (status.state === 'paused') {
    box.dataset.state = 'paused';
    line.textContent =
      status.access === false
        ? `The key is saved, but grabs can’t sync: Chrome’s access to ${saved.endpoint} is off. Press Save settings to grant it.`
        : `The key is saved, but grabs are not syncing yet.${
            status.error
              ? ` The last vault test failed: ${status.error}`
              : ' Test the vault to start syncing.'
          }`;
  } else {
    box.dataset.state = 'none';
    line.textContent =
      'Not connected. Paste the API key from Obsidian → Settings → Local REST API, then save.';
  }
  element('vault-remember').hidden = status.state === 'none' || status.remembered;
  // The key itself never comes back to the page; the field only says one is held.
  input('api-key').placeholder =
    status.state === 'none'
      ? 'Paste the key from your local plugin'
      : 'Key saved. Paste a new key to replace it.';
  element('key-state').textContent =
    status.state === 'none'
      ? 'No vault key stored. Capture can queue locally until you connect.'
      : 'A vault key is stored. Leave the field blank to keep it.';
}
async function refreshVault(): Promise<void> {
  try {
    renderVault(await command({ v: 1, type: 'GET_STATE' }));
  } catch {
    /* The next load, test or visit reads it again. */
  }
}
/** After Save or Test, scroll the least distance that shows the whole status beside them. */
const revealVault = () => element('vault-status').scrollIntoView({ block: 'nearest' });
function renderActivation(): void {
  element('activation-state').textContent =
    activation === 'universal'
      ? 'On across your browser. Hold Shift or Ctrl and circle to capture.'
      : activation === 'paused'
        ? 'Paused everywhere. Your saved captures are retained.'
        : 'Not enabled across tabs yet. Enable once to keep the hand with you.';
  element<HTMLButtonElement>('global-enable').disabled = activation === 'universal';
  element<HTMLButtonElement>('global-pause').disabled = activation === 'paused';
}
function formSettings(): Settings {
  const excluded = element<HTMLTextAreaElement>('excluded')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const url = new URL(line);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.href !== `${url.origin}/`
      )
        throw new Error('Excluded sites must be origins such as https://example.com');
      return url.origin;
    });
  return {
    ...settings,
    endpoint: input('endpoint').value.trim(),
    folder: input('folder').value.trim(),
    allowInsecureLoopback: input('allow-http').checked,
    rememberKey: input('remember-key').checked,
    excludedOrigins: excluded,
    features: {
      images: input('feature-images').checked,
      youtube: input('feature-youtube').checked,
      semantic: input('feature-semantic').checked,
      haunting: input('feature-haunting').checked,
      gaze: false,
    },
  };
}
async function load(): Promise<State> {
  const state = await command({ v: 1, type: 'GET_STATE' });
  settings = state.settings ?? structuredClone(defaultSettings);
  activation = state.activation ?? 'manual';
  renderActivation();
  input('endpoint').value = settings.endpoint;
  input('folder').value = settings.folder;
  input('remember-key').checked = settings.rememberKey;
  input('allow-http').checked = settings.allowInsecureLoopback;
  for (const feature of ['images', 'youtube', 'semantic', 'haunting'] as const)
    input(`feature-${feature}`).checked = settings.features[feature];
  if (__CORE_ONLY__)
    for (const feature of ['images', 'youtube']) {
      input(`feature-${feature}`).disabled = true;
      input(`feature-${feature}`).checked = false;
    }
  element<HTMLTextAreaElement>('excluded').value = settings.excludedOrigins.join('\n');
  renderVault(state);
  return state;
}
async function saveSettings(): Promise<void> {
  const next = formSettings();
  const url = new URL(next.endpoint);
  if (
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error('Use the numeric loopback API endpoint, such as https://127.0.0.1:27124');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && next.allowInsecureLoopback))
    throw new Error('Use HTTPS, or explicitly enable loopback HTTP.');
  const granted = await chrome.permissions.request({ origins: [originPattern(next.endpoint)] });
  if (!granted) throw new Error('Vault endpoint permission was not granted.');
  const key = input('api-key').value.trim();
  await command({
    v: 1,
    type: 'SAVE_SETTINGS',
    settings: next,
    ...(key ? { apiKey: key } : {}),
  });
  input('api-key').value = '';
}
/** Runs the vault test. Sync stays paused, with the reason shown, unless it passes. */
async function testVault(opening: string): Promise<void> {
  testing = true;
  clearTimeout(vaultRefresh);
  element('vault-status').dataset.state = 'testing';
  element('vault-state').textContent = 'Testing the vault…';
  revealVault();
  notice(opening);
  try {
    const response = await command({ v: 1, type: 'PROBE_VAULT' });
    notice(response.message ?? 'Vault connected', 'success');
  } finally {
    testing = false;
    followQueue();
    await refreshVault();
    revealVault();
  }
}
element<HTMLFormElement>('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void busy(vaultButtons(), async () => {
    // Save brings back access that was off, but what waited meanwhile is sent only after a
    // passing test.
    const accessWasOff = shownStatus?.access === false;
    await saveSettings();
    followQueue();
    const status = (await load()).vaultStatus;
    // A changed vault or key, or one never tested, leaves sync paused, and a failed test
    // stands until a test passes: one press tests, connects and sends what waited.
    if (status?.state === 'paused' || status?.error || accessWasOff)
      try {
        await testVault(
          'Settings saved. Testing create-only writes, version conflicts and attachment bytes…',
        );
      } catch (error) {
        // The settings did save; only the test after them failed.
        throw new Error(
          `Settings saved, but the vault test failed: ${error instanceof Error ? error.message : 'it could not complete.'}`,
        );
      }
    else {
      revealVault();
      notice('Settings saved.', 'success');
    }
  });
});
element<HTMLButtonElement>('connect').addEventListener('click', () => {
  void busy(vaultButtons(), async () => {
    await saveSettings();
    await load();
    await testVault('Testing create-only writes, version conflicts and attachment bytes…');
  });
});
document.addEventListener('visibilitychange', () => {
  // Grabs made in other tabs change what is waiting to sync.
  if (document.visibilityState === 'visible' && !testing) {
    followQueue();
    void refreshVault();
  }
});
// Site access can change in chrome://extensions while this page stays in view, and Save
// decides from what the page shows, so the status follows it.
for (const changed of [chrome.permissions.onAdded, chrome.permissions.onRemoved])
  changed.addListener(() => {
    if (!testing) {
      followQueue();
      void refreshVault();
    }
  });
element<HTMLButtonElement>('forget').addEventListener(
  'click',
  () =>
    void busy(vaultButtons(), async () => {
      await command({ v: 1, type: 'FORGET_KEY' });
      input('api-key').value = '';
      await load();
      notice('Vault key forgotten. Pending captures remain local.', 'success');
    }),
);
element<HTMLButtonElement>('prepare-model').addEventListener(
  'click',
  () =>
    void busy(element('prepare-model'), async () => {
      notice('Preparing the bundled local model…');
      const response = await command({ v: 1, type: 'PREPARE_MODEL' });
      notice(response.message ?? 'Search ready', 'success');
    }),
);
element('global-enable').addEventListener('click', () => {
  // Start the browser prompt directly inside this user gesture.
  const intent = command({ v: 1, type: 'BEGIN_ACTIVATION' });
  const permission = chrome.permissions.request({ origins: [...universalPageOrigins] });
  void busy(element('global-enable'), async () => {
    const [request, granted] = await Promise.all([intent, permission]);
    if (!granted)
      throw new Error('Site access was not granted. The hand has not been enabled across tabs.');
    if (!request.activationRequest)
      throw new Error('Could not start activation. Please try again.');
    await command({
      v: 1,
      type: 'SET_ACTIVATION',
      enabled: true,
      requestId: request.activationRequest,
    });
    await load();
    notice(
      'Zombie Brain is on across your browser. Hold Shift or Ctrl and circle a passage.',
      'success',
    );
  }).then(renderActivation);
});
element('global-pause').addEventListener('click', () => {
  void busy(element('global-pause'), async () => {
    await command({ v: 1, type: 'SET_ACTIVATION', enabled: false });
    await load();
    notice(
      'Zombie Brain is paused everywhere. Your saved captures remain in the graveyard.',
      'success',
    );
  }).then(renderActivation);
});
if (!__CORE_ONLY__) {
  element('media-access').hidden = false;
  const mediaOrigin = () => {
    const url = publicMediaUrl(input('media-origin').value.trim());
    if (url.pathname !== '/' || url.search || url.hash)
      throw new Error('Enter just the media origin, such as https://images.example.com.');
    return url.origin;
  };
  element('grant-media').addEventListener(
    'click',
    () =>
      void busy(element('grant-media'), async () => {
        const origin = mediaOrigin();
        if (!(await chrome.permissions.request({ origins: [originPattern(origin)] })))
          throw new Error('Image-origin access was not granted.');
        await command({ v: 1, type: 'GRANT_MEDIA_ORIGIN', origin });
        notice(
          'Image-origin access granted. Capture the image again to try saving its original bytes.',
          'success',
        );
      }),
  );
  element('revoke-media').addEventListener(
    'click',
    () =>
      void busy(element('revoke-media'), async () => {
        const origin = mediaOrigin();
        await command({ v: 1, type: 'REVOKE_MEDIA_ORIGIN', origin });
        const state = await command({ v: 1, type: 'GET_STATE' });
        if (state.activation !== 'universal')
          await chrome.permissions.remove({ origins: [originPattern(origin)] });
        notice(
          'Original-image access removed. Captures from this host will use a visible crop or source link.',
          'success',
        );
      }),
  );
}
void load().catch((error: unknown) =>
  notice(error instanceof Error ? error.message : 'Could not load settings', 'error'),
);
