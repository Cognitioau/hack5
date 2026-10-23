import { secureStorage } from './settings';

export type HandActivationMode = 'manual' | 'universal' | 'paused';
// Chrome requires <all_urls> for visible crops on tabs that never received an
// activeTab toolbar gesture. Injection itself remains restricted to HTTP(S).
export const universalPageOrigins: readonly string[] = __CORE_ONLY__
  ? ['http://*/*', 'https://*/*']
  : ['<all_urls>'];

export interface HandActivation {
  readonly ready: Promise<void>;
  getMode(): HandActivationMode;
  enable(): Promise<void>;
  pause(): Promise<void>;
  wake(tabId: number, manual?: boolean): Promise<void>;
  refresh(): Promise<void>;
}

interface ActivationOptions {
  allowedOrigin(url: string): Promise<boolean>;
  onPause(): void;
}

/** Browser-wide intent is persisted separately from per-page capture capabilities. */
export function createHandActivation(options: ActivationOptions): HandActivation {
  let mode: HandActivationMode = 'paused';
  let epoch = 0;
  let storageQueue: Promise<void> = Promise.resolve();
  const tabQueues = new Map<number, Promise<void>>();

  const persist = (next: 'universal' | 'paused', intent: number): Promise<void> => {
    const write = storageQueue
      .catch(() => undefined)
      .then(async () => {
        await secureStorage();
        if (epoch === intent) await chrome.storage.local.set({ handActivation: next });
      });
    storageQueue = write;
    return write;
  };

  const forTab = (tabId: number, task: () => Promise<void>): Promise<void> => {
    const work = (tabQueues.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(task);
    tabQueues.set(tabId, work);
    const cleanup = () => {
      if (tabQueues.get(tabId) === work) tabQueues.delete(tabId);
    };
    void work.then(cleanup, cleanup);
    return work;
  };

  const deactivate = async (tabId: number): Promise<void> => {
    try {
      await chrome.tabs.sendMessage(tabId, { v: 1, type: 'DEACTIVATE' }, { frameId: 0 });
    } catch {
      // Closed/restricted tabs and tabs without the content entry have no receiver.
    }
  };

  const deactivateAll = async (intent: number): Promise<void> => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id === undefined
          ? Promise.resolve()
          : forTab(tab.id, async () => {
              if (epoch === intent && mode === 'paused') await deactivate(tab.id as number);
            }),
      ),
    );
  };

  function pause(): Promise<void> {
    // Do this before the first await: neither permission prompts nor in-flight
    // injections can turn a deliberate pause into a later activation.
    const intent = ++epoch;
    mode = 'paused';
    let callbackError: unknown;
    try {
      options.onPause();
    } catch (error) {
      callbackError = error;
    }
    return Promise.allSettled([persist('paused', intent), deactivateAll(intent)]).then(
      (results) => {
        if (callbackError) throw callbackError;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      },
    );
  }

  const startupEpoch = epoch;
  const ready = (async (): Promise<void> => {
    await secureStorage();
    const stored = await chrome.storage.local.get('handActivation');
    if (epoch !== startupEpoch) return;
    if (stored.handActivation === undefined) {
      mode = 'manual';
      return;
    }
    if (stored.handActivation === 'universal') {
      const granted = await chrome.permissions.contains({ origins: [...universalPageOrigins] });
      if (epoch !== startupEpoch) return;
      if (granted) {
        mode = 'universal';
        return;
      }
    }
    // A paused preference, an invalid value, or a revoked broad host grant all
    // fail closed. Clear content left in open tabs by a previous worker too.
    await pause();
  })();

  const canWake = (intent: number, manual: boolean): boolean =>
    epoch === intent && mode !== 'paused' && (manual || mode === 'universal');

  const publicTabUrl = (tab: chrome.tabs.Tab): string | null => {
    if (!tab.active || !tab.url) return null;
    try {
      const url = new URL(tab.url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  };

  const granted = (): Promise<boolean> =>
    chrome.permissions.contains({ origins: [...universalPageOrigins] });

  async function wake(tabId: number, manual = false): Promise<void> {
    const intent = epoch;
    try {
      await ready;
    } catch {
      return;
    }
    if (!canWake(intent, manual)) return;
    await forTab(tabId, async () => {
      let attempted = false;
      try {
        if (!canWake(intent, manual)) return;
        const initial = await chrome.tabs.get(tabId);
        const url = publicTabUrl(initial);
        if (!url || !canWake(intent, manual)) return;
        if (!manual && !(await granted())) return;
        if (!canWake(intent, manual) || !(await options.allowedOrigin(url))) return;
        const current = await chrome.tabs.get(tabId);
        if (publicTabUrl(current) !== url || !canWake(intent, manual)) return;
        if (!(await options.allowedOrigin(url)) || !canWake(intent, manual)) return;
        if (!manual && !(await granted())) return;
        const latest = await chrome.tabs.get(tabId);
        if (publicTabUrl(latest) !== url || !canWake(intent, manual)) return;
        attempted = true;
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: ['content.js'],
        });
        if (!canWake(intent, manual)) {
          await deactivate(tabId);
          return;
        }
        const after = await chrome.tabs.get(tabId);
        if (
          !canWake(intent, manual) ||
          publicTabUrl(after) !== url ||
          !(await options.allowedOrigin(url)) ||
          (!manual && !(await granted())) ||
          !canWake(intent, manual)
        )
          await deactivate(tabId);
      } catch {
        // A tab can close/navigate, or a grant can disappear during any await.
        if (attempted) await deactivate(tabId);
      }
    });
  }

  async function refresh(): Promise<void> {
    try {
      await ready;
    } catch {
      return;
    }
    if (mode !== 'universal') return;
    const intent = epoch;
    const tabs = await chrome.tabs.query({ active: true });
    if (!canWake(intent, false)) return;
    await Promise.all(tabs.map((tab) => (tab.id === undefined ? Promise.resolve() : wake(tab.id))));
  }

  async function enable(): Promise<void> {
    const intent = ++epoch;
    await ready;
    if (epoch !== intent) return;
    const permissionBefore = await granted();
    if (epoch !== intent) return;
    if (!permissionBefore) throw new Error('Allow the requested browser site access first.');
    await persist('universal', intent);
    if (epoch !== intent) return;
    // The permission may have been revoked while the preference was being saved.
    const permissionAfter = await granted();
    if (epoch !== intent) return;
    if (!permissionAfter) {
      await pause();
      throw new Error('Browser access changed before Zombie Brain could be enabled.');
    }
    if (epoch !== intent) return;
    mode = 'universal';
    await refresh();
  }

  return { ready, getMode: () => mode, enable, pause, wake, refresh };
}
