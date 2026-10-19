import {
  defaultSettings,
  settingsSchema,
  type Settings,
  type VaultConfig,
} from '../../core/contracts';

let trusted: Promise<void> | undefined;
export const secureStorage = () =>
  (trusted ??= Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).then(() => undefined));
export async function readSettings(): Promise<Settings> {
  await secureStorage();
  const stored = await chrome.storage.local.get('settings');
  const parsed = settingsSchema.safeParse(stored.settings);
  return parsed.success ? parsed.data : structuredClone(defaultSettings);
}
export async function readVaultConfig(): Promise<VaultConfig | undefined> {
  const settings = await readSettings();
  const session = await chrome.storage.session.get('vaultKey');
  const remembered = settings.rememberKey ? await chrome.storage.local.get('vaultKey') : {};
  const key = session.vaultKey ?? remembered.vaultKey;
  if (typeof key !== 'string' || !key) return undefined;
  return {
    endpoint: settings.endpoint,
    folder: settings.folder,
    allowInsecureLoopback: settings.allowInsecureLoopback,
    apiKey: key,
  };
}
export async function writeSettings(settings: Settings, key?: string): Promise<void> {
  await secureStorage();
  const parsed = settingsSchema.parse(settings);
  const previous = await readSettings();
  const oldKey = (await readVaultConfig())?.apiKey;
  const changedDestination = previous.endpoint !== parsed.endpoint;
  const nextKey = key?.trim() || (changedDestination ? undefined : oldKey);
  await Promise.all([
    chrome.storage.local.remove('vaultKey'),
    chrome.storage.session.remove('vaultKey'),
  ]);
  if (nextKey)
    await (parsed.rememberKey ? chrome.storage.local : chrome.storage.session).set({
      vaultKey: nextKey,
    });
  await chrome.storage.local.set({ settings: parsed });
}
export async function forgetKey(): Promise<void> {
  await secureStorage();
  await Promise.all([
    chrome.storage.local.remove('vaultKey'),
    chrome.storage.session.remove('vaultKey'),
  ]);
}
export const originPattern = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
};

export async function allowedOrigin(url: string): Promise<boolean> {
  const settings = await readSettings();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(parsed.protocol) &&
    !settings.excludedOrigins.includes(parsed.origin)
  );
}
