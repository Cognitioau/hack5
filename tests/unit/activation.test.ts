import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandActivation } from '../../src/adapters/browser/activation';

let stored: Record<string, unknown>;
let permissionGranted: boolean;
let tabs: Map<number, chrome.tabs.Tab>;
let activation: HandActivation;
let create: typeof import('../../src/adapters/browser/activation').createHandActivation;

const storageGet = vi.fn(async (_key: string) => ({ ...stored }));
const storageSet = vi.fn(async (value: Record<string, unknown>) => {
  Object.assign(stored, value);
});
const contains = vi.fn(async (_permissions: chrome.permissions.Permissions) => permissionGranted);
const query = vi.fn(async (filter: chrome.tabs.QueryInfo) =>
  [...tabs.values()].filter((tab) => !filter.active || tab.active).map((tab) => ({ ...tab })),
);
const get = vi.fn(async (tabId: number) => {
  const tab = tabs.get(tabId);
  if (!tab) throw new Error('Tab closed');
  return { ...tab };
});
const execute = vi.fn(
  async (_injection: { target: { tabId: number; frameIds?: number[] }; files?: string[] }) => [],
);
const send = vi.fn(async (_tabId: number, _message: unknown, _options: unknown) => undefined);
const allowedOrigin = vi.fn(async (_url: string) => true);
const onPause = vi.fn();

function tab(id: number, url = `https://example.org/page-${id}`, active = true): chrome.tabs.Tab {
  return {
    id,
    url,
    active,
    index: 0,
    windowId: 1,
    pinned: false,
    highlighted: active,
    incognito: false,
    selected: active,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  } as chrome.tabs.Tab;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function start(preference?: unknown): Promise<void> {
  if (preference !== undefined) stored.handActivation = preference;
  activation = create({ allowedOrigin, onPause });
  await activation.ready;
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('__CORE_ONLY__', false);
  stored = {};
  permissionGranted = true;
  tabs = new Map([[1, tab(1)]]);
  storageGet.mockReset().mockImplementation(async () => ({ ...stored }));
  storageSet.mockReset().mockImplementation(async (value) => {
    Object.assign(stored, value);
  });
  contains.mockReset().mockImplementation(async () => permissionGranted);
  query
    .mockReset()
    .mockImplementation(async (filter) =>
      [...tabs.values()]
        .filter((entry) => !filter.active || entry.active)
        .map((entry) => ({ ...entry })),
    );
  get.mockReset().mockImplementation(async (tabId) => {
    const entry = tabs.get(tabId);
    if (!entry) throw new Error('Tab closed');
    return { ...entry };
  });
  execute.mockReset().mockResolvedValue([]);
  send.mockReset().mockResolvedValue(undefined);
  allowedOrigin.mockReset().mockResolvedValue(true);
  onPause.mockReset();
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: storageGet, set: storageSet, setAccessLevel: vi.fn(async () => undefined) },
      session: { setAccessLevel: vi.fn(async () => undefined) },
    },
    permissions: { contains },
    tabs: { query, get, sendMessage: send },
    scripting: { executeScript: execute },
  });
  create = (await import('../../src/adapters/browser/activation')).createHandActivation;
});

afterEach(() => vi.unstubAllGlobals());

describe('browser-wide activation intent', () => {
  it('keeps an existing installation manual until explicitly enabled', async () => {
    permissionGranted = false;
    await start();
    expect(activation.getMode()).toBe('manual');
    await activation.refresh();
    await activation.wake(1);
    expect(execute).not.toHaveBeenCalled();
    await activation.wake(1, true);
    expect(execute).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      files: ['content.js'],
    });
    expect(contains).not.toHaveBeenCalled();
  });

  it('requires the all-sites crop grant before persisting full universal activation', async () => {
    await start();
    permissionGranted = false;
    await expect(activation.enable()).rejects.toThrow('site access');
    expect(contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(activation.getMode()).toBe('manual');
    expect(stored.handActivation).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the core profile limited to HTTP(S) without a screenshot capability', async () => {
    vi.resetModules();
    vi.stubGlobal('__CORE_ONLY__', true);
    create = (await import('../../src/adapters/browser/activation')).createHandActivation;
    await start();
    permissionGranted = false;
    await expect(activation.enable()).rejects.toThrow('site access');
    expect(contains).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists universal mode and wakes active permitted HTTP(S) tabs only', async () => {
    tabs.set(2, tab(2, 'https://example.org/background', false));
    tabs.set(3, tab(3, 'chrome://extensions'));
    tabs.set(4, tab(4, 'https://private.example.org'));
    tabs.set(5, tab(5, 'http://public.example.org'));
    allowedOrigin.mockImplementation(async (url) => !url.includes('private.example.org'));
    await start();
    await activation.enable();
    expect(stored.handActivation).toBe('universal');
    expect(activation.getMode()).toBe('universal');
    expect(execute.mock.calls.map(([injection]) => injection.target.tabId).sort()).toEqual([1, 5]);
    expect(
      execute.mock.calls.every(([injection]) => injection.target.frameIds?.join() === '0'),
    ).toBe(true);
  });

  it('restores universal mode on worker restart and wakes a newly active tab', async () => {
    await start('universal');
    await activation.refresh();
    tabs.set(2, tab(2, 'https://example.org/new-tab'));
    tabs.set(1, tab(1, 'https://example.org/page-1', false));
    await activation.wake(2);
    expect(execute.mock.calls.map(([injection]) => injection.target.tabId)).toEqual([1, 2]);
  });

  it.each(['paused', 'invalid'] as const)(
    'fails closed on a stored %s preference and deactivates existing content',
    async (preference) => {
      await start(preference);
      await activation.refresh();
      await activation.wake(1, true);
      expect(activation.getMode()).toBe('paused');
      expect(stored.handActivation).toBe('paused');
      expect(execute).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(1, { v: 1, type: 'DEACTIVATE' }, { frameId: 0 });
    },
  );

  it('reconciles a revoked host grant to a persisted pause on restart', async () => {
    permissionGranted = false;
    await start('universal');
    expect(activation.getMode()).toBe('paused');
    expect(stored.handActivation).toBe('paused');
    expect(onPause).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(1, { v: 1, type: 'DEACTIVATE' }, { frameId: 0 });
  });

  it('blocks immediately when paused and deactivates active and inactive tabs', async () => {
    tabs.set(2, tab(2, 'https://example.org/background', false));
    await start('universal');
    const pending = activation.pause();
    expect(activation.getMode()).toBe('paused');
    expect(onPause).toHaveBeenCalledOnce();
    await Promise.all([pending, activation.wake(1), activation.wake(2, true)]);
    expect(execute).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([id]) => id).sort()).toEqual([1, 2]);
    expect(stored.handActivation).toBe('paused');
  });

  it('keeps a pause made while startup storage is pending', async () => {
    const load = deferred<Record<string, unknown>>();
    storageGet.mockImplementationOnce(() => load.promise);
    activation = create({ allowedOrigin, onPause });
    await vi.waitFor(() => expect(storageGet).toHaveBeenCalled());
    const pause = activation.pause();
    load.resolve({ handActivation: 'universal' });
    await Promise.all([activation.ready, pause, activation.refresh()]);
    expect(activation.getMode()).toBe('paused');
    expect(stored.handActivation).toBe('paused');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a permission check finishing late reverse a newer pause', async () => {
    await start();
    const permission = deferred<boolean>();
    contains.mockImplementationOnce(() => permission.promise);
    const enabling = activation.enable();
    await vi.waitFor(() => expect(contains).toHaveBeenCalled());
    const pausing = activation.pause();
    permission.resolve(true);
    await Promise.all([enabling, pausing]);
    expect(activation.getMode()).toBe('paused');
    expect(stored.handActivation).toBe('paused');
    expect(execute).not.toHaveBeenCalled();
  });

  it('orders preference writes so an earlier enable cannot overwrite a pause', async () => {
    await start();
    const write = deferred<void>();
    storageSet.mockImplementationOnce(async (value) => {
      await write.promise;
      Object.assign(stored, value);
    });
    const enabling = activation.enable();
    await vi.waitFor(() =>
      expect(storageSet).toHaveBeenCalledWith({ handActivation: 'universal' }),
    );
    const pausing = activation.pause();
    expect(activation.getMode()).toBe('paused');
    write.resolve();
    await Promise.all([enabling, pausing]);
    expect(stored.handActivation).toBe('paused');
    expect(execute).not.toHaveBeenCalled();
  });

  it('still deactivates tabs if the pause preference cannot be saved', async () => {
    await start('universal');
    storageSet.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(activation.pause()).rejects.toThrow('Storage unavailable');
    expect(activation.getMode()).toBe('paused');
    expect(onPause).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(1, { v: 1, type: 'DEACTIVATE' }, { frameId: 0 });
    await activation.wake(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['pause', 'navigation', 'inactive', 'revoked'] as const)(
    'rechecks %s while an origin decision is pending',
    async (change) => {
      await start('universal');
      const origin = deferred<boolean>();
      allowedOrigin.mockImplementationOnce(() => origin.promise);
      const waking = activation.wake(1);
      await vi.waitFor(() => expect(allowedOrigin).toHaveBeenCalled());
      let pausing: Promise<void> | undefined;
      switch (change) {
        case 'pause':
          pausing = activation.pause();
          break;
        case 'navigation':
          tabs.set(1, tab(1, 'https://another.example.org'));
          break;
        case 'inactive':
          tabs.set(1, tab(1, 'https://example.org/page-1', false));
          break;
        case 'revoked':
          permissionGranted = false;
          break;
      }
      origin.resolve(true);
      await Promise.all([waking, pausing]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('checks the current URL again after the final origin decision', async () => {
    await start('universal');
    const origin = deferred<boolean>();
    allowedOrigin.mockResolvedValueOnce(true).mockImplementationOnce(() => origin.promise);
    const waking = activation.wake(1);
    await vi.waitFor(() => expect(allowedOrigin).toHaveBeenCalledTimes(2));
    tabs.set(1, tab(1, 'https://different.example.org'));
    origin.resolve(true);
    await waking;
    expect(execute).not.toHaveBeenCalled();
  });

  it('deactivates a late injection after pause before allowing any later activation', async () => {
    await start('universal');
    const injected = deferred<never[]>();
    execute.mockImplementationOnce(() => injected.promise);
    const waking = activation.wake(1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    const pausing = activation.pause();
    expect(activation.getMode()).toBe('paused');
    injected.resolve([]);
    await Promise.all([waking, pausing]);
    expect(send).toHaveBeenCalledWith(1, { v: 1, type: 'DEACTIVATE' }, { frameId: 0 });
    await activation.wake(1, true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('orders a new enable behind an older in-flight deactivation', async () => {
    await start('universal');
    const deactivated = deferred<undefined>();
    send.mockImplementationOnce(() => deactivated.promise);
    const pausing = activation.pause();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const enabling = activation.enable();
    await vi.waitFor(() => expect(stored.handActivation).toBe('universal'));
    expect(execute).not.toHaveBeenCalled();
    deactivated.resolve(undefined);
    await Promise.all([pausing, enabling]);
    expect(activation.getMode()).toBe('universal');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('deactivates content if navigation or exclusion changes during injection', async () => {
    await start('universal');
    const injected = deferred<never[]>();
    execute.mockImplementationOnce(() => injected.promise);
    const waking = activation.wake(1);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    allowedOrigin.mockResolvedValue(false);
    injected.resolve([]);
    await waking;
    expect(send).toHaveBeenCalledWith(1, { v: 1, type: 'DEACTIVATE' }, { frameId: 0 });
  });

  it('treats closed tabs and missing receivers as normal during refresh and pause', async () => {
    await start('universal');
    get.mockRejectedValueOnce(new Error('Tab closed'));
    await expect(activation.refresh()).resolves.toBeUndefined();
    send.mockRejectedValueOnce(new Error('No receiver'));
    await expect(activation.pause()).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
