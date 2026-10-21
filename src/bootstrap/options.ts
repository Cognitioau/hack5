import { defaultSettings, type AppResponse, type Settings } from '../core/contracts';
import { command } from '../adapters/browser/client';
import { universalPageOrigins } from '../adapters/browser/activation';
import { originPattern } from '../adapters/browser/settings';
import { publicMediaUrl } from '../core/domain/security';
import { busy, element, notice } from '../ui/common';

const input = (id: string) => element<HTMLInputElement>(id);
let settings: Settings = structuredClone(defaultSettings);
let activation: Extract<AppResponse, { ok: true }>['activation'] = 'manual';
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
async function load() {
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
  element('key-state').textContent = state.hasKey
    ? 'A vault key is stored. Leave the field blank to keep it.'
    : 'No vault key stored. Capture can queue locally until you connect.';
}
async function save() {
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
  const response = await command({
    v: 1,
    type: 'SAVE_SETTINGS',
    settings: next,
    ...(key ? { apiKey: key } : {}),
  });
  input('api-key').value = '';
  notice(response.message ?? 'Settings saved', 'success');
  await load();
}
element<HTMLFormElement>('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button =
    element<HTMLFormElement>('settings-form').querySelector<HTMLButtonElement>(
      'button[type=submit]',
    );
  if (button) void busy(button, save);
});
element<HTMLButtonElement>('connect').addEventListener('click', () => {
  const button = element<HTMLButtonElement>('connect');
  void busy(button, async () => {
    await save();
    notice('Testing create-only writes, version conflicts and attachment bytes…');
    const response = await command({ v: 1, type: 'PROBE_VAULT' });
    notice(response.message ?? 'Vault connected', 'success');
  });
});
element<HTMLButtonElement>('forget').addEventListener(
  'click',
  () =>
    void busy(element('forget'), async () => {
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
      'Zombie Hand is on across your browser. Hold Shift or Ctrl and circle a passage.',
      'success',
    );
  }).then(renderActivation);
});
element('global-pause').addEventListener('click', () => {
  void busy(element('global-pause'), async () => {
    await command({ v: 1, type: 'SET_ACTIVATION', enabled: false });
    await load();
    notice(
      'Zombie Hand is paused everywhere. Your saved captures remain in the graveyard.',
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
