import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contentMessageSchema,
  defaultSettings,
  type AppResponse,
  type CaptureCandidate,
  type CaptureRecord,
  type Settings,
  type VaultConfig,
  type VaultRepository,
  type VaultSaveResult,
} from '../../src/core/contracts';
import type { createCaptureStore } from '../../src/adapters/persistence/indexed-db';
import { searchableChunks } from '../../src/core/domain/retrieval';

const ports = vi.hoisted(() => ({
  createVault: vi.fn(),
  embed: vi.fn(),
  prepare: vi.fn(),
  dispose: vi.fn(),
  download: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('../../src/adapters/persistence/vault', () => ({ createVaultClient: ports.createVault }));
vi.mock('../../src/adapters/inference/local-embedder', () => ({
  LocalEmbedder: class {
    readonly id = 'fixture-model';
    embed = ports.embed;
    prepare = ports.prepare;
    dispose = ports.dispose;
  },
}));
vi.mock('../../src/adapters/browser/media', () => ({
  downloadImage: ports.download,
  cropSnapshot: ports.snapshot,
}));

// Exercise the production background listener and coordinator, with synthetic browser/port
// boundaries. These tests do not establish actual Chrome permission or worker-lifecycle behavior.
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const pageUrl = 'https://page.example/article';
const fixtureKey = 'synthetic-background-vault-key';
type Listener = (
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: AppResponse) => void,
) => boolean | undefined;
type Store = ReturnType<typeof createCaptureStore>;
type Gate = { entered: Promise<void>; release(): void };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event<T>() {
  const listeners: T[] = [];
  return {
    listeners,
    addListener: vi.fn((listener: T) => {
      listeners.push(listener);
    }),
  };
}

function storageArea(initial: Record<string, unknown> = {}) {
  const values = structuredClone(initial);
  const reads: {
    key: string;
    entered: ReturnType<typeof deferred<void>>;
    done: ReturnType<typeof deferred<void>>;
  }[] = [];
  const writes: typeof reads = [];
  const allGates: typeof reads = [];
  function schedule(list: typeof reads, key: string): Gate {
    const entry = { key, entered: deferred<void>(), done: deferred<void>() };
    list.push(entry);
    allGates.push(entry);
    return { entered: entry.entered.promise, release: () => entry.done.resolve() };
  }
  return {
    values,
    deferRead: (key: string) => schedule(reads, key),
    deferWrite: (key: string) => schedule(writes, key),
    releaseAll: () => {
      for (const gate of allGates) gate.done.resolve();
    },
    get: vi.fn(async (key: string) => {
      const snapshot = key in values ? structuredClone({ [key]: values[key] }) : {};
      const index = reads.findIndex((entry) => entry.key === key);
      if (index >= 0) {
        const gate = reads.splice(index, 1)[0];
        gate?.entered.resolve();
        await gate?.done.promise;
      }
      return snapshot;
    }),
    set: vi.fn(async (data: Record<string, unknown>) => {
      const index = writes.findIndex((entry) => Object.hasOwn(data, entry.key));
      if (index >= 0) {
        const gate = writes.splice(index, 1)[0];
        gate?.entered.resolve();
        await gate?.done.promise;
      }
      Object.assign(values, structuredClone(data));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key];
    }),
    setAccessLevel: vi.fn(async () => undefined),
  };
}

function candidate(): CaptureCandidate {
  return {
    kind: 'text',
    title: 'Synthetic browser capture',
    url: pageUrl,
    text: 'Orchids need controlled light and water.',
  };
}

function imageCandidate(): CaptureCandidate {
  return {
    ...candidate(),
    kind: 'image',
    image: {
      url: 'https://images.example/pixel.png',
      alt: 'Synthetic pixel',
      rect: { x: 0, y: 0, width: 10, height: 10, viewportWidth: 800, viewportHeight: 600 },
    },
  };
}

function transcriptImport(operationId = crypto.randomUUID()) {
  return {
    v: 1,
    type: 'IMPORT_TRANSCRIPT',
    operationId,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Synthetic imported transcript',
    seconds: 2,
    text: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOrchids need controlled light.\n\n00:00:04.000 --> 00:00:07.000\nWater the roots carefully.\n',
  };
}

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  const id = crypto.randomUUID();
  return {
    schemaVersion: 1,
    id,
    operationId: id,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    candidate: { ...candidate(), url: 'https://notes.example/saved' },
    lifecycle: 'active',
    lifecycleRevision: 0,
    contentRevision: 0,
    preservation: 'text',
    persistence: 'saved-vault',
    indexState: 'disabled',
    preparation: 'ready',
    ...overrides,
  };
}

function tab(id = 101, url = pageUrl): chrome.tabs.Tab {
  return {
    id,
    url,
    index: 0,
    active: true,
    highlighted: true,
    pinned: false,
    incognito: false,
    selected: true,
    windowId: 1,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    frozen: false,
    lastAccessed: 0,
  };
}

function harness() {
  const settings = structuredClone(defaultSettings);
  settings.features.semantic = false;
  const local = storageArea({ settings, syncPaused: false });
  const session = storageArea({ vaultKey: fixtureKey });
  const messages = event<Listener>();
  const permissionRemoved = event<(permissions: chrome.permissions.Permissions) => void>();
  const permissionAdded = event<(permissions: chrome.permissions.Permissions) => void>();
  const tabUpdated =
    event<(tabId: number, change: chrome.tabs.OnUpdatedInfo, value: chrome.tabs.Tab) => void>();
  const tabs = new Map<number, chrome.tabs.Tab>([[101, tab()]]);
  const contains = vi.fn(async (_permissions: chrome.permissions.Permissions) => true);
  const transmitted: { url: string; authorization: string | null }[] = [];
  const network = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('Synthetic aborted transport', 'AbortError');
    transmitted.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const vault: VaultRepository = {
    ensureCapture: vi.fn(
      async (capture: CaptureRecord): Promise<VaultSaveResult> => ({
        status: 'saved-vault',
        metadataEtag: '"fixture-etag"',
        vault: {
          notePath: `Zombie Hand/captures/${capture.id}.md`,
          metadataPath: `Zombie Hand/metadata/${capture.id}.json`,
          metadataEtag: '"fixture-etag"',
        },
      }),
    ),
    syncLifecycle: vi.fn(async (): Promise<VaultSaveResult> => ({ status: 'saved-vault' })),
    probe: vi.fn(async () => ({ ok: true, message: 'Synthetic capability probe' })),
    importCaptures: vi.fn(async () => ({ records: [], skipped: 0 })),
  };
  const api = {
    runtime: {
      id: extensionId,
      onMessage: messages,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      openOptionsPage: vi.fn(async () => undefined),
      onInstalled: event<() => void>(),
      onStartup: event<() => void>(),
    },
    storage: { local, session },
    permissions: { contains, onRemoved: permissionRemoved, onAdded: permissionAdded },
    tabs: {
      get: vi.fn(async (id: number) => structuredClone(tabs.get(id))),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) =>
        [...tabs.values()]
          .filter((item) => !query.active || item.active)
          .map((item) => structuredClone(item)),
      ),
      sendMessage: vi.fn(async (..._message: unknown[]): Promise<unknown> => undefined),
      onUpdated: tabUpdated,
      onActivated: event<(info: { tabId: number; windowId: number }) => void>(),
      onRemoved: event<(id: number) => void>(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: event<(windowId: number) => void>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      onAlarm: event<(alarm: chrome.alarms.Alarm) => void>(),
    },
  };
  const sender = (
    overrides: Partial<chrome.runtime.MessageSender> = {},
  ): chrome.runtime.MessageSender => ({
    id: extensionId,
    tab: tab(),
    frameId: 0,
    documentId: 'document-1',
    documentLifecycle: 'active',
    url: pageUrl,
    ...overrides,
  });
  const trusted: chrome.runtime.MessageSender = {
    id: extensionId,
    url: api.runtime.getURL('options.html'),
  };
  const send = (raw: unknown, from = sender()) =>
    new Promise<AppResponse>((resolve, reject) => {
      const listener = messages.listeners[0];
      if (!listener) {
        reject(new Error('The background message listener was not installed'));
        return;
      }
      listener(raw, from, resolve);
    });
  const sendTrusted = (raw: unknown) => send(raw, trusted);
  return {
    local,
    session,
    contains,
    vault,
    api,
    sender,
    trusted,
    send,
    sendTrusted,
    tabs,
    tabUpdated,
    permissionRemoved,
    permissionAdded,
    network,
    transmitted,
  };
}

let context: ReturnType<typeof harness>;
/** The toolbar popup: a trusted extension page, like settings and the graveyard. */
const popup = (): chrome.runtime.MessageSender => ({
  id: extensionId,
  url: context.api.runtime.getURL('popup.html'),
});
let store: Store;
let backgroundStore: Store;

async function arm(from = context.sender(), value = candidate()): Promise<string> {
  const response = await context.send({ v: 1, type: 'ARM', pageUrl, candidate: value }, from);
  expect(response.ok).toBe(true);
  if (!response.ok || !response.token) throw new Error('Synthetic arm request failed');
  return response.token;
}

async function seed(value: CaptureRecord): Promise<void> {
  await store.create(value);
  if (value.persistence === 'saved-vault')
    await store.settle(value.id, value.lifecycleRevision, { status: 'saved-vault' });
}

async function settled(id: string): Promise<CaptureRecord> {
  await vi.waitFor(async () => expect((await store.get(id))?.persistence).toBe('saved-vault'));
  const value = await store.get(id);
  if (!value) throw new Error('Synthetic capture disappeared');
  return value;
}

function switchViewAwayAndBack(kind: 'tab' | 'focus'): void {
  if (kind === 'focus') {
    context.api.windows.onFocusChanged.listeners[0]?.(-1);
    context.api.windows.onFocusChanged.listeners[0]?.(1);
    return;
  }
  context.tabs.set(101, { ...tab(), active: false });
  context.tabs.set(202, { ...tab(), id: 202, url: 'https://other.example/private', active: true });
  context.api.tabs.onActivated.listeners[0]?.({ tabId: 202, windowId: 1 });
  context.tabs.set(202, { ...tab(), id: 202, url: 'https://other.example/private', active: false });
  context.tabs.set(101, tab());
  context.api.tabs.onActivated.listeners[0]?.({ tabId: 101, windowId: 1 });
}

beforeEach(async () => {
  vi.resetModules();
  for (const mock of Object.values(ports)) mock.mockReset();
  ports.embed.mockResolvedValue([1, 0]);
  ports.prepare.mockResolvedValue(undefined);
  ports.dispose.mockResolvedValue(undefined);
  context = harness();
  ports.createVault.mockImplementation(() => context.vault);
  vi.stubGlobal('chrome', context.api);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('__CORE_ONLY__', false);
  vi.stubGlobal('fetch', context.network);
  const persistence = await import('../../src/adapters/persistence/indexed-db');
  const createStore = persistence.createCaptureStore;
  store = createStore();
  vi.spyOn(persistence, 'createCaptureStore').mockImplementation((name) => {
    backgroundStore = createStore(name);
    return backgroundStore;
  });
  await import('../../src/bootstrap/background');
  expect((await context.sendTrusted({ v: 1, type: 'GET_STATE' })).ok).toBe(true);
});

afterEach(async () => {
  context.local.releaseAll();
  context.session.releaseAll();
  context.permissionRemoved.listeners[0]?.({ origins: ['https://127.0.0.1/*'] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await store.close();
  await backgroundStore.close();
  vi.unstubAllGlobals();
});

describe('production background capability boundary', () => {
  it('recreates a missing retry alarm on worker startup without requiring installation', () => {
    expect(context.api.alarms.get).toHaveBeenCalledWith('resume-captures');
    expect(context.api.alarms.create).toHaveBeenCalledWith('resume-captures', {
      periodInMinutes: 1,
    });
    expect(context.api.alarms.create).toHaveBeenCalledOnce();
  });

  it('does not let a new arm acquire, read or archive an existing capture ID', async () => {
    const existing = record();
    await seed(existing);
    const token = await arm();
    expect(
      (await context.send({ v: 1, type: 'CAPTURE', token, operationId: existing.id })).ok,
    ).toBe(false);
    expect((await context.send({ v: 1, type: 'GET_CAPTURE', captureId: existing.id })).ok).toBe(
      false,
    );
    expect((await context.send({ v: 1, type: 'ARCHIVE', captureId: existing.id })).ok).toBe(false);
    expect((await context.send({ v: 1, type: 'CANCEL', token, operationId: existing.id })).ok).toBe(
      true,
    );
    expect((await store.get(existing.id))?.lifecycle).toBe('active');
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it('allows an exact replay only through its original confirmed capability', async () => {
    const token = await arm();
    const id = crypto.randomUUID();
    const command = { v: 1, type: 'CAPTURE', token, operationId: id };
    expect((await context.send(command)).ok).toBe(true);
    await settled(id);
    expect((await context.send(command)).ok).toBe(true);
    expect(context.vault.ensureCapture).toHaveBeenCalledOnce();
    expect((await store.list()).map((item) => item.id)).toEqual([id]);
    expect((await context.send({ ...command, operationId: crypto.randomUUID() })).ok).toBe(false);
    const another = await arm();
    expect((await context.send({ ...command, token: another })).ok).toBe(false);
  });

  it('rejects a mismatched cancel before changing the original capture or capability', async () => {
    const token = await arm();
    const id = crypto.randomUUID();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    expect((await settled(id)).vault?.metadataEtag).toBe('"fixture-etag"');
    expect(
      (await context.send({ v: 1, type: 'CANCEL', token, operationId: crypto.randomUUID() })).ok,
    ).toBe(false);
    expect((await store.get(id))?.lifecycle).toBe('active');
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    expect((await context.send({ v: 1, type: 'CANCEL', token, operationId: id })).ok).toBe(true);
    expect((await store.get(id))?.lifecycle).toBe('archived');
    await vi.waitFor(() => expect(context.vault.ensureCapture).toHaveBeenCalledTimes(2));
    expect(vi.mocked(context.vault.ensureCapture).mock.calls[1]?.[0].vault?.metadataEtag).toBe(
      '"fixture-etag"',
    );
  });

  it('does not poison an operation ID when a non-video timestamp is rejected', async () => {
    const token = await arm();
    const operationId = crypto.randomUUID();
    expect(
      (await context.send({ v: 1, type: 'CAPTURE', token, operationId, videoSeconds: 5 })).ok,
    ).toBe(false);
    expect(await store.get(operationId)).toBeUndefined();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId })).ok).toBe(true);
    await settled(operationId);
  });

  it('rejects a token from a different document and invalidates it on same-URL navigation', async () => {
    const token = await arm();
    const command = { v: 1, type: 'CAPTURE', token, operationId: crypto.randomUUID() };
    expect((await context.send(command, context.sender({ documentId: 'document-2' }))).ok).toBe(
      false,
    );
    context.tabUpdated.listeners[0]?.(101, { status: 'loading' }, tab());
    expect((await context.send(command)).ok).toBe(false);
    expect(await store.list()).toHaveLength(0);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it('rejects an arm when the claimed page URL disagrees with the active tab', async () => {
    expect(
      (
        await context.send({
          v: 1,
          type: 'ARM',
          pageUrl: 'https://other.example/',
          candidate: candidate(),
        })
      ).ok,
    ).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it.each([
    { id: 'another-extension' },
    { frameId: 1 },
    { documentLifecycle: 'cached' },
    { documentId: undefined },
  ])('rejects an invalid Chrome sender: %j', async (override) => {
    const sender = { ...context.sender(), ...override } as chrome.runtime.MessageSender;
    expect(
      (await context.send({ v: 1, type: 'ARM', pageUrl, candidate: candidate() }, sender)).ok,
    ).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  // Every page message, read from the schema so a new one cannot skip the sender check.
  const pageMessages: Record<string, () => Promise<Record<string, unknown>>> = {
    CONTENT_STATUS: async () => ({ v: 1, type: 'CONTENT_STATUS' }),
    OPEN_SETTINGS: async () => ({ v: 1, type: 'OPEN_SETTINGS' }),
    READ_PAGE: async () => ({ v: 1, type: 'READ_PAGE' }),
    HAND_SPRITE: async () => {
      context.network.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
      return { v: 1, type: 'HAND_SPRITE', hand: 0 };
    },
    ARM: async () => ({ v: 1, type: 'ARM', pageUrl, candidate: candidate() }),
    CAPTURE: async () => ({
      v: 1,
      type: 'CAPTURE',
      token: await arm(),
      operationId: crypto.randomUUID(),
    }),
    CANCEL: async () => ({ v: 1, type: 'CANCEL', token: await arm() }),
    ARCHIVE: async () => ({ v: 1, type: 'ARCHIVE', captureId: await captured() }),
    GET_CAPTURE: async () => ({ v: 1, type: 'GET_CAPTURE', captureId: await captured() }),
    SEARCH: async () => ({ v: 1, type: 'SEARCH', query: 'orchids' }),
  };
  const pageTypes = contentMessageSchema.options.map((option) => option.shape.type.value);

  async function captured(): Promise<string> {
    const token = await arm();
    const id = crypto.randomUUID();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    await settled(id);
    return id;
  }

  it('has a sample for every page message', () => {
    expect(Object.keys(pageMessages).sort()).toEqual([...pageTypes].sort());
  });

  it.each(pageTypes)('accepts %s only from the enabled top-level page', async (type) => {
    const message = await pageMessages[type]?.();
    expect(contentMessageSchema.safeParse(message).success).toBe(true);
    for (const override of [
      { id: 'another-extension' },
      { frameId: 1 },
      { documentLifecycle: 'cached' },
      { documentId: undefined },
    ]) {
      const sender = { ...context.sender(), ...override } as chrome.runtime.MessageSender;
      expect((await context.send(message, sender)).ok, JSON.stringify(override)).toBe(false);
    }
    expect((await context.send(message)).ok).toBe(true);
  });

  it('does not grant trusted settings authority to page messages or lookalike extension URLs', async () => {
    const before = structuredClone(context.local.values.settings);
    const settings = { ...defaultSettings, folder: 'Unrequested destination' };
    const command = { v: 1, type: 'SAVE_SETTINGS', settings, apiKey: 'synthetic-unwanted-key' };
    expect((await context.send(command)).ok).toBe(false);
    expect(
      (
        await context.send(command, {
          id: extensionId,
          url: `${context.api.runtime.getURL('options.html')}.evil`,
        })
      ).ok,
    ).toBe(false);
    expect(context.local.values.settings).toEqual(before);
    expect(context.session.values.vaultKey).toBe(fixtureKey);
  });

  it.each([
    { v: 1, type: 'SET_ACTIVATION', enabled: true },
    { v: 1, type: 'SET_ACTIVATION', enabled: false },
    { v: 1, type: 'BEGIN_ACTIVATION' },
    { v: 1, type: 'PAUSE_HAND' },
    { v: 1, type: 'GRAB_ACTIVE_TAB', kind: 'page' },
    { v: 1, type: 'GRANT_MEDIA_ORIGIN', origin: 'https://images.example.org' },
    { v: 1, type: 'REVOKE_MEDIA_ORIGIN', origin: 'https://images.example.org' },
  ])(
    'does not expose activation or image-download consent to page messages: %j',
    async (message) => {
      expect((await context.send(message)).ok).toBe(false);
      expect(context.local.values.handActivation).toBeUndefined();
      expect(context.local.values.mediaOriginGrants).toBeUndefined();
      expect(context.api.tabs.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('loads the article reader into only the document that asked, and only from the package', async () => {
    expect(await context.send({ v: 1, type: 'READ_PAGE' })).toEqual({ ok: true });
    expect(context.api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(context.api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: context.sender().tab?.id, documentIds: ['document-1'] },
      files: ['page-reader.js'],
    });
    // A page can only ask for the reader, never name a file or another document.
    for (const message of [
      { v: 1, type: 'READ_PAGE', files: ['background.js'] },
      { v: 1, type: 'READ_PAGE', documentId: 'document-2' },
    ])
      expect((await context.send(message)).ok, JSON.stringify(message)).toBe(false);
    expect(context.api.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('hands a page only a packaged hand, read from the extension origin', async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 128]);
    context.network.mockImplementationOnce(async () => new Response(bytes));
    expect(await context.send({ v: 1, type: 'HAND_SPRITE', hand: 1 })).toMatchObject({
      ok: true,
      sprite: btoa(String.fromCharCode(...bytes)),
    });
    expect(context.network).toHaveBeenLastCalledWith(
      context.api.runtime.getURL('assets/grave-hand-1.bin'),
    );
    // A page can only name a packaged hand by number, never choose a file.
    const calls = context.network.mock.calls.length;
    for (const message of [
      { v: 1, type: 'HAND_SPRITE', hand: 1, path: 'models/private' },
      { v: 1, type: 'HAND_SPRITE', path: 'models/private' },
      { v: 1, type: 'HAND_SPRITE', hand: '../models/private' },
      { v: 1, type: 'HAND_SPRITE', hand: -1 },
      { v: 1, type: 'HAND_SPRITE', hand: 0.5 },
      { v: 1, type: 'HAND_SPRITE', hand: 15 },
    ])
      expect((await context.send(message)).ok).toBe(false);
    expect(context.network.mock.calls.length).toBe(calls);
  });

  it('retries a hand after a failed read instead of caching the failure', async () => {
    context.network.mockImplementationOnce(async () => new Response('', { status: 404 }));
    expect((await context.send({ v: 1, type: 'HAND_SPRITE', hand: 0 })).ok).toBe(false);
    context.network.mockImplementationOnce(async () => new Response(new Uint8Array([1, 2, 3])));
    expect(await context.send({ v: 1, type: 'HAND_SPRITE', hand: 0 })).toMatchObject({
      ok: true,
      sprite: btoa('\x01\x02\x03'),
    });
  });

  it('opens the settings page for a page, and nothing else', async () => {
    const before = await store.list();
    expect((await context.send({ v: 1, type: 'OPEN_SETTINGS' })).ok).toBe(true);
    expect(context.api.runtime.openOptionsPage).toHaveBeenCalledOnce();
    expect(context.local.values.handActivation).not.toBe('paused');
    expect(await store.list()).toEqual(before);
  });

  it('pauses from the toolbar, then rejects stale arming and confirmation', async () => {
    const token = await arm();
    expect((await context.send({ v: 1, type: 'SET_ACTIVATION', enabled: false }, popup())).ok).toBe(
      true,
    );
    expect(context.local.values.handActivation).toBe('paused');
    expect((await context.send({ v: 1, type: 'ARM', pageUrl, candidate: candidate() })).ok).toBe(
      false,
    );
    expect(
      (await context.send({ v: 1, type: 'CAPTURE', token, operationId: crypto.randomUUID() })).ok,
    ).toBe(false);
    expect(await store.list()).toHaveLength(0);
    expect(context.api.tabs.sendMessage).toHaveBeenCalledWith(
      101,
      { v: 1, type: 'DEACTIVATE' },
      { frameId: 0 },
    );
  });

  it('grabs from the toolbar on the active tab, waking it first and passing back its answer', async () => {
    const replies: unknown[] = [{ ok: true }, { ok: false, error: `<b>${'x'.repeat(400)}</b>` }];
    context.api.tabs.sendMessage.mockImplementation(async () => replies.shift());
    expect(
      await context.send({ v: 1, type: 'GRAB_ACTIVE_TAB', kind: 'selection' }, popup()),
    ).toEqual({ ok: true });
    expect(context.api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 101, frameIds: [0] },
      files: ['content.js'],
    });
    expect(context.api.tabs.sendMessage).toHaveBeenLastCalledWith(
      101,
      { v: 1, type: 'GRAB', kind: 'selection' },
      { frameId: 0 },
    );
    // The page's words come back as bounded plain data for the popup's textContent.
    const refused = await context.send({ v: 1, type: 'GRAB_ACTIVE_TAB', kind: 'page' }, popup());
    expect(refused).toEqual({ ok: false, error: `<b>${'x'.repeat(297)}` });
    // A page with no hand to answer (a browser page, an excluded site) says so.
    expect(
      await context.send({ v: 1, type: 'GRAB_ACTIVE_TAB', kind: 'page' }, popup()),
    ).toMatchObject({ ok: false, error: expect.stringContaining('cannot reach this page') });
    // Paused means no page is touched at all.
    await context.send({ v: 1, type: 'SET_ACTIVATION', enabled: false }, popup());
    context.api.tabs.sendMessage.mockClear();
    context.api.scripting.executeScript.mockClear();
    expect(
      await context.send({ v: 1, type: 'GRAB_ACTIVE_TAB', kind: 'page' }, popup()),
    ).toMatchObject({ ok: false, error: expect.stringContaining('paused everywhere') });
    expect(context.api.scripting.executeScript).not.toHaveBeenCalled();
    expect(context.api.tabs.sendMessage).not.toHaveBeenCalledWith(
      101,
      expect.objectContaining({ type: 'GRAB' }),
      expect.anything(),
    );
  });

  it('trusts the popup page by its exact address only', async () => {
    const lookalike = { id: extensionId, url: `${context.api.runtime.getURL('popup.html')}.evil` };
    expect(
      (await context.send({ v: 1, type: 'GRAB_ACTIVE_TAB', kind: 'page' }, lookalike)).ok,
    ).toBe(false);
    expect(context.api.tabs.sendMessage).not.toHaveBeenCalled();
    expect((await context.send({ v: 1, type: 'GET_STATE' }, popup())).ok).toBe(true);
  });

  it("finishes a toolbar activation on Chrome's grant when the prompt closed the popup", async () => {
    let granted = false;
    context.contains.mockImplementation(async () => granted);
    const started = await context.send({ v: 1, type: 'BEGIN_ACTIVATION' }, popup());
    if (!started.ok || !started.activationRequest) throw new Error('Missing activation intent');
    granted = true;
    context.permissionAdded.listeners[0]?.({ origins: ['<all_urls>'] });
    await vi.waitFor(() => expect(context.local.values.handActivation).toBe('universal'));
    // A popup that did survive the prompt finishes the same activation harmlessly.
    expect(
      await context.send(
        { v: 1, type: 'SET_ACTIVATION', enabled: true, requestId: started.activationRequest },
        popup(),
      ),
    ).toMatchObject({ ok: true, activation: 'universal' });
  });

  it('answers a popup that survived the prompt while the grant is still turning the hand on', async () => {
    let granted = false;
    context.contains.mockImplementation(async () => granted);
    const started = await context.send({ v: 1, type: 'BEGIN_ACTIVATION' }, popup());
    if (!started.ok || !started.activationRequest) throw new Error('Missing activation intent');
    granted = true;
    const writing = context.local.deferWrite('handActivation');
    context.permissionAdded.listeners[0]?.({ origins: ['<all_urls>'] });
    await writing.entered;
    const reply = context.send(
      { v: 1, type: 'SET_ACTIVATION', enabled: true, requestId: started.activationRequest },
      popup(),
    );
    writing.release();
    expect(await reply).toMatchObject({ ok: true, activation: 'universal' });
  });

  it('leaves a paused hand alone when site access was already held and another origin is granted', async () => {
    await context.send({ v: 1, type: 'SET_ACTIVATION', enabled: false }, popup());
    // Access already held needs no prompt, so this request can only be finished by its own popup.
    await context.send({ v: 1, type: 'BEGIN_ACTIVATION' }, popup());
    context.permissionAdded.listeners[0]?.({ origins: ['https://images.example.org/*'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.local.values.handActivation).toBe('paused');
  });

  it('ignores a grant that arrives long after the prompt began', async () => {
    await context.send({ v: 1, type: 'SET_ACTIVATION', enabled: false }, popup());
    let granted = false;
    context.contains.mockImplementation(async () => granted);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      await context.send({ v: 1, type: 'BEGIN_ACTIVATION' }, popup());
      // Denied, say, then granted much later from chrome://extensions.
      now.mockReturnValue(1_000_000 + 10 * 60_000);
      granted = true;
      context.permissionAdded.listeners[0]?.({ origins: ['<all_urls>'] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(context.local.values.handActivation).toBe('paused');
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    'no prompt began',
    'the prompt was superseded by a pause',
    'the grant was not site access',
  ] as const)('leaves the hand alone on a grant when %s', async (situation) => {
    context.contains.mockImplementation(async () => situation !== 'the grant was not site access');
    if (situation !== 'no prompt began')
      await context.send({ v: 1, type: 'BEGIN_ACTIVATION' }, popup());
    if (situation === 'the prompt was superseded by a pause')
      await context.send({ v: 1, type: 'SET_ACTIVATION', enabled: false }, popup());
    const before = context.local.values.handActivation;
    context.permissionAdded.listeners[0]?.({ origins: ['https://images.example.org/*'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.local.values.handActivation).toBe(before);
    expect(context.local.values.handActivation).not.toBe('universal');
  });

  it.each(['pause', 'permission-removal'] as const)(
    'rejects an old activation prompt after %s',
    async (interruption) => {
      const started = await context.sendTrusted({ v: 1, type: 'BEGIN_ACTIVATION' });
      if (!started.ok || !started.activationRequest) throw new Error('Missing activation intent');
      if (interruption === 'pause')
        await context.sendTrusted({ v: 1, type: 'SET_ACTIVATION', enabled: false });
      else context.permissionRemoved.listeners[0]?.({ origins: ['https://*/*'] });
      const late = await context.sendTrusted({
        v: 1,
        type: 'SET_ACTIVATION',
        enabled: true,
        requestId: started.activationRequest,
      });
      expect(late.ok).toBe(false);
      expect(context.local.values.handActivation).toBe('paused');
      expect(context.api.scripting.executeScript).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized data at the real listener before invoking a privileged port', async () => {
    expect(
      (
        await context.send({
          v: 1,
          type: 'ARM',
          pageUrl,
          candidate: { ...candidate(), text: 'x'.repeat(400_000) },
        })
      ).ok,
    ).toBe(false);
    expect(ports.createVault).not.toHaveBeenCalled();
    expect(ports.embed).not.toHaveBeenCalled();
  });

  it('requires an enabled image capability when arming', async () => {
    const settings = context.local.values.settings as Settings;
    settings.features.images = false;
    expect(
      (await context.send({ v: 1, type: 'ARM', pageUrl, candidate: imageCandidate() })).ok,
    ).toBe(false);
    expect(ports.download).not.toHaveBeenCalled();
    expect(ports.snapshot).not.toHaveBeenCalled();
  });
});

describe('background settings and asynchronous revocation', () => {
  it.each(['tab', 'focus'] as const)(
    'discards an in-flight crop after %s switches away and back while retaining the active capture',
    async (change) => {
      ports.download.mockRejectedValue(new Error('Original image origin was not authorized'));
      const snapshot = deferred<CaptureRecord['asset']>();
      ports.snapshot.mockReturnValueOnce(snapshot.promise);
      const token = await arm(context.sender(), imageCandidate());
      const id = crypto.randomUUID();
      expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
      await vi.waitFor(() => expect(ports.snapshot).toHaveBeenCalledOnce());
      const signal = ports.snapshot.mock.calls[0]?.[4] as AbortSignal;
      expect(signal.aborted).toBe(false);

      // Both active-tab snapshots would see the original page. The transition
      // itself must invalidate any screenshot acquired during the gap.
      switchViewAwayAndBack(change);
      expect(signal.aborted).toBe(true);
      snapshot.resolve({
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        mimeType: 'image/png',
        extension: 'png',
      });
      const saved = await settled(id);
      expect(saved.preparation).toBe('ready');
      expect(saved.lifecycle).toBe('active');
      expect(saved.asset).toBeUndefined();
      expect(saved.preservation).toBe('link');
      expect(saved.candidate).toEqual(imageCandidate());
      expect(context.vault.ensureCapture).toHaveBeenCalled();
      expect(
        vi.mocked(context.vault.ensureCapture).mock.calls.every(([capture]) => !capture.asset),
      ).toBe(true);
      expect((await context.send({ v: 1, type: 'GET_CAPTURE', captureId: id })).ok).toBe(true);
    },
  );

  it.each([
    { change: 'tab', settingsRead: 1 },
    { change: 'focus', settingsRead: 1 },
    { change: 'tab', settingsRead: 3 },
    { change: 'focus', settingsRead: 3 },
  ] as const)(
    'rejects delayed ARM across a $change switch during settings read $settingsRead',
    async ({ change, settingsRead }) => {
      const entered = deferred<void>();
      const resume = deferred<void>();
      const get = context.local.get.getMockImplementation();
      if (!get) throw new Error('Synthetic storage implementation is missing');
      let reads = 0;
      context.local.get.mockImplementation(async (key) => {
        const snapshot = await get(key);
        if (key === 'settings' && ++reads === settingsRead) {
          entered.resolve();
          await resume.promise;
        }
        return snapshot;
      });
      const pending = context.send({ v: 1, type: 'ARM', pageUrl, candidate: imageCandidate() });
      await entered.promise;
      switchViewAwayAndBack(change);
      resume.resolve();
      expect((await pending).ok).toBe(false);
      expect(await store.list()).toEqual([]);
      expect(ports.download).not.toHaveBeenCalled();
      expect(ports.snapshot).not.toHaveBeenCalled();
      // Returning to the same page permits a fresh, deliberate arm.
      expect(await arm()).toEqual(expect.any(String));
    },
  );

  it.each(['settings', 'permission'] as const)(
    'rejects an ARM whose final settings read resumes after %s revocation',
    async (revocation) => {
      const entered = deferred<void>();
      const resume = deferred<void>();
      const get = context.local.get.getMockImplementation();
      if (!get) throw new Error('Synthetic storage implementation is missing');
      let settingsReads = 0;
      context.local.get.mockImplementation(async (key) => {
        const snapshot = await get(key);
        // Two active-document checks precede ARM's feature decision. Hold that final snapshot.
        if (key === 'settings' && ++settingsReads === 3) {
          entered.resolve();
          await resume.promise;
        }
        return snapshot;
      });
      const arming = context.send({ v: 1, type: 'ARM', pageUrl, candidate: imageCandidate() });
      await entered.promise;
      if (revocation === 'permission')
        context.permissionRemoved.listeners[0]?.({ origins: ['https://127.0.0.1/*'] });
      else {
        const settings = structuredClone(context.local.values.settings as Settings);
        settings.features.images = false;
        expect((await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings })).ok).toBe(
          true,
        );
      }
      resume.resolve();
      expect((await arming).ok).toBe(false);
      expect(await store.list()).toEqual([]);
      expect(ports.download).not.toHaveBeenCalled();
    },
  );

  it.each(['permission', 'navigation'] as const)(
    'discards media revoked by %s inside the durable mutation boundary',
    async (revocation) => {
      ports.download.mockResolvedValue({
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        mimeType: 'image/png',
        extension: 'png',
      });
      const update = backgroundStore.update.bind(backgroundStore);
      let interrupted = false;
      vi.spyOn(backgroundStore, 'update').mockImplementation((id, change, queue) =>
        update(
          id,
          (current) => {
            if (!interrupted && current.preparation === 'pending') {
              interrupted = true;
              if (revocation === 'permission')
                context.permissionRemoved.listeners[0]?.({ origins: ['https://127.0.0.1/*'] });
              else context.tabUpdated.listeners[0]?.(101, { status: 'loading' }, tab());
            }
            return change(current);
          },
          queue,
        ),
      );
      const token = await arm(context.sender(), imageCandidate());
      const id = crypto.randomUUID();
      expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
      await vi.waitFor(async () => expect((await store.get(id))?.preparation).toBe('ready'));
      expect(interrupted).toBe(true);
      expect((await store.get(id))?.asset).toBeUndefined();
      expect((await store.get(id))?.preservation).toBe('link');
      expect(
        vi.mocked(context.vault.ensureCapture).mock.calls.every(([record]) => !record.asset),
      ).toBe(true);
    },
  );

  it('does not attach media to a capture archived while its durable update is waiting', async () => {
    ports.download.mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: 'image/png',
      extension: 'png',
    });
    const entered = deferred<void>();
    const resume = deferred<void>();
    const update = backgroundStore.update.bind(backgroundStore);
    let held = false;
    vi.spyOn(backgroundStore, 'update').mockImplementation(async (id, change, queue) => {
      if (!held) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return update(id, change, queue);
    });
    const token = await arm(context.sender(), imageCandidate());
    const id = crypto.randomUUID();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    await entered.promise;
    expect(
      (
        await context.sendTrusted({
          v: 1,
          type: 'SET_LIFECYCLE',
          captureId: id,
          lifecycle: 'archived',
        })
      ).ok,
    ).toBe(true);
    resume.resolve();
    await vi.waitFor(async () => expect((await store.get(id))?.preparation).toBe('ready'));
    const saved = await store.get(id);
    expect(saved?.lifecycle).toBe('archived');
    expect(saved?.asset).toBeUndefined();
    expect(saved?.preservation).toBe('link');
    expect(
      vi
        .mocked(context.vault.ensureCapture)
        .mock.calls.every(([record]) => !record.asset && record.lifecycle === 'archived'),
    ).toBe(true);
  });

  it('does not let a config read begun before Forget Key attach to a new controller', async () => {
    const permission = deferred<boolean>();
    context.contains.mockReturnValueOnce(permission.promise);
    const testing = context.sendTrusted({ v: 1, type: 'PROBE_VAULT' });
    await vi.waitFor(() => expect(context.contains).toHaveBeenCalled());
    expect((await context.sendTrusted({ v: 1, type: 'FORGET_KEY' })).ok).toBe(true);
    permission.resolve(true);
    expect((await testing).ok).toBe(false);
    expect(ports.createVault).not.toHaveBeenCalled();
    expect(context.session.values.vaultKey).toBeUndefined();
  });

  it('does not let a successful old probe authorize a newly selected destination', async () => {
    const probe = deferred<{ ok: boolean; message: string }>();
    vi.mocked(context.vault.probe).mockReturnValueOnce(probe.promise);
    const testing = context.sendTrusted({ v: 1, type: 'PROBE_VAULT' });
    await vi.waitFor(() => expect(context.vault.probe).toHaveBeenCalled());
    const settings: Settings = {
      ...(context.local.values.settings as Settings),
      endpoint: 'https://127.0.0.1:27224',
      folder: 'Other Test Vault',
    };
    expect(
      (
        await context.sendTrusted({
          v: 1,
          type: 'SAVE_SETTINGS',
          settings,
          apiKey: 'synthetic-new-endpoint-key',
        })
      ).ok,
    ).toBe(true);
    expect(context.local.values.syncPaused).toBe(true);
    probe.resolve({ ok: true, message: 'The obsolete endpoint replied late' });
    expect((await testing).ok).toBe(false);
    expect(context.local.values.syncPaused).toBe(true);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it('does not let a delayed old probe commit unpause a newly selected destination', async () => {
    const commit = context.local.deferWrite('syncPaused');
    const testing = context.sendTrusted({ v: 1, type: 'PROBE_VAULT' });
    await commit.entered;
    const settings: Settings = {
      ...(context.local.values.settings as Settings),
      endpoint: 'https://127.0.0.1:27224',
      folder: 'Other Test Vault',
    };
    const saving = context.sendTrusted({
      v: 1,
      type: 'SAVE_SETTINGS',
      settings,
      apiKey: 'synthetic-new-endpoint-key',
    });
    // Give a concurrent mutation time to reach storage; a serialized implementation may queue it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    commit.release();
    const [saved] = await Promise.all([saving, testing]);
    if (saved.ok) {
      expect((context.local.values.settings as Settings).endpoint).toBe(settings.endpoint);
      expect(context.local.values.syncPaused).toBe(true);
    } else {
      expect((context.local.values.settings as Settings).endpoint).not.toBe(settings.endpoint);
    }
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it('does not read mixed credentials and destination while a settings write is pending', async () => {
    const writing = context.local.deferWrite('settings');
    const settings: Settings = {
      ...(context.local.values.settings as Settings),
      endpoint: 'https://127.0.0.1:27224',
    };
    const saving = context.sendTrusted({
      v: 1,
      type: 'SAVE_SETTINGS',
      settings,
      apiKey: 'synthetic-new-endpoint-key',
    });
    await writing.entered;
    const testing = await context.sendTrusted({ v: 1, type: 'PROBE_VAULT' });
    expect(testing.ok).toBe(false);
    expect(ports.createVault).not.toHaveBeenCalled();
    writing.release();
    expect((await saving).ok).toBe(true);
    expect(context.local.values.syncPaused).toBe(true);
  });

  it('stops subsequent credential use from a previously cached client after key revocation', async () => {
    const firstWrite = deferred<void>();
    const continueWrite = deferred<void>();
    ports.createVault.mockImplementation(
      (config: VaultConfig, options: { fetch: typeof fetch }): VaultRepository => ({
        ...context.vault,
        ensureCapture: async () => {
          await options.fetch(`${config.endpoint}/first-write`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          });
          firstWrite.resolve();
          await continueWrite.promise;
          try {
            await options.fetch(`${config.endpoint}/late-write`, {
              headers: { Authorization: `Bearer ${config.apiKey}` },
            });
            return { status: 'saved-vault' };
          } catch {
            return { status: 'uncertain', message: 'Synthetic revoked transport' };
          }
        },
      }),
    );
    const token = await arm();
    const id = crypto.randomUUID();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    await firstWrite.promise;
    expect((await context.sendTrusted({ v: 1, type: 'FORGET_KEY' })).ok).toBe(true);
    continueWrite.resolve();
    await vi.waitFor(async () => expect((await store.get(id))?.persistence).toBe('uncertain'));
    expect(context.transmitted).toHaveLength(1);
    expect(context.transmitted[0]?.url).toContain('/first-write');
    expect(context.network).toHaveBeenCalledTimes(2);
    expect(context.network.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(await store.pending()).toHaveLength(1);
  });

  it('does not start semantic search from settings read before semantic disable', async () => {
    const enabled = context.local.values.settings as Settings;
    enabled.features.semantic = true;
    await seed(record());
    const reading = context.local.deferRead('settings');
    const searching = context.sendTrusted({ v: 1, type: 'SEARCH', query: 'orchids' });
    await reading.entered;
    const disabled = structuredClone(enabled);
    disabled.features.semantic = false;
    expect(
      (await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings: disabled })).ok,
    ).toBe(true);
    reading.release();
    const result = await searching;
    expect(result.ok).toBe(true);
    expect(ports.embed).not.toHaveBeenCalled();
    if (result.ok) expect(result.results?.every((item) => item.mode === 'keyword')).toBe(true);
  });

  it('does not start indexing from enabled settings read before semantic disable', async () => {
    const enabled = context.local.values.settings as Settings;
    enabled.features.semantic = true;
    const readGate = deferred<Gate>();
    vi.mocked(context.vault.ensureCapture).mockImplementationOnce(async () => {
      const gate = context.local.deferRead('settings');
      readGate.resolve(gate);
      return { status: 'saved-vault' };
    });
    const token = await arm();
    const id = crypto.randomUUID();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    const reading = await readGate.promise;
    await reading.entered;
    const disabled = structuredClone(enabled);
    disabled.features.semantic = false;
    expect(
      (await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings: disabled })).ok,
    ).toBe(true);
    reading.release();
    await settled(id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ports.embed).not.toHaveBeenCalled();
    expect((await store.get(id))?.vectors).toBeUndefined();
  });

  it('rejects indexing results revoked immediately before the durable mutation callback', async () => {
    (context.local.values.settings as Settings).features.semantic = true;
    const update = backgroundStore.update.bind(backgroundStore);
    let revoked = false;
    vi.spyOn(backgroundStore, 'update').mockImplementation((id, change, queue) =>
      update(
        id,
        (current) => {
          if (queue === false && !revoked) {
            revoked = true;
            context.permissionRemoved.listeners[0]?.({ origins: ['https://127.0.0.1/*'] });
          }
          return change(current);
        },
        queue,
      ),
    );
    const token = await arm();
    const id = crypto.randomUUID();
    expect((await context.send({ v: 1, type: 'CAPTURE', token, operationId: id })).ok).toBe(true);
    await vi.waitFor(() => expect(revoked).toBe(true));
    expect(ports.embed).toHaveBeenCalled();
    expect((await store.get(id))?.vectors).toBeUndefined();
    expect((await store.get(id))?.indexState).not.toBe('ready');
  });

  it('does not reopen the model from a Prepare request whose settings read was revoked', async () => {
    const enabled = context.local.values.settings as Settings;
    enabled.features.semantic = true;
    const reading = context.local.deferRead('settings');
    const preparing = context.sendTrusted({ v: 1, type: 'PREPARE_MODEL' });
    await reading.entered;
    const disabled = structuredClone(enabled);
    disabled.features.semantic = false;
    expect(
      (await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings: disabled })).ok,
    ).toBe(true);
    reading.release();
    expect((await preparing).ok).toBe(false);
    expect(ports.prepare).not.toHaveBeenCalled();
  });

  it('haunts a page only with a note close in meaning, never a keyword match', async () => {
    const settings = context.local.values.settings as Settings;
    settings.features.semantic = true;
    settings.features.haunting = true;
    // The query embeds to [1, 0], so each note's score is the first part of its vector.
    const note = (
      name: string,
      score: number | null,
      url = `https://notes.example/${name}`,
    ): CaptureRecord => {
      const saved = record({
        indexState: score === null ? 'disabled' : 'ready',
        candidate: { ...candidate(), url },
      });
      if (score !== null)
        saved.vectors = searchableChunks(saved).map((chunk) => ({
          ...chunk,
          hash: 'synthetic-hash',
          model: 'fixture-model',
          vector: [score, Math.sqrt(1 - score * score)],
        }));
      return saved;
    };
    for (const saved of [
      note('related', 0.54),
      note('near', 0.31),
      note('boundary', 0.3),
      note('unrelated', 0.29),
      // Notes not yet indexed match every word, and outnumber the 20 a search returns.
      ...Array.from({ length: 20 }, (_, index) => note(`keyword-${index}`, null)),
      // So do closer notes grabbed from the page being read, which never haunt it.
      ...Array.from({ length: 20 }, (_, index) => note(`self-${index}`, 0.6, pageUrl)),
    ])
      await seed(saved);
    const query = { v: 1, type: 'SEARCH', query: 'Orchids need controlled light and water.' };
    const urls = (response: AppResponse) =>
      response.ok ? response.results?.map((item) => item.capture.candidate.url) : undefined;
    expect(urls(await context.send(query))).toEqual([
      'https://notes.example/related',
      'https://notes.example/near',
      'https://notes.example/boundary',
    ]);
    // The graveyard's own search still ranks the keyword matches first.
    const listed = urls(await context.sendTrusted(query));
    expect(listed).toHaveLength(20);
    expect(listed?.every((url) => url?.startsWith('https://notes.example/keyword-'))).toBe(true);
    // A note is judged by each of its passages: one indexed passage close in meaning
    // haunts, though another passage, not yet indexed, matches every keyword.
    const mixed = record({
      indexState: 'ready',
      candidate: {
        ...candidate(),
        url: 'https://notes.example/mixed',
        text: `${candidate().text} ${'Ferns grow in shade. '.repeat(100)}`,
      },
    });
    const passages = searchableChunks(mixed);
    expect(passages).toHaveLength(2);
    mixed.vectors = passages.slice(1).map((chunk) => ({
      ...chunk,
      hash: 'synthetic-hash',
      model: 'fixture-model',
      vector: [0.45, Math.sqrt(1 - 0.45 * 0.45)],
    }));
    await seed(mixed);
    expect(urls(await context.send(query))).toEqual([
      'https://notes.example/related',
      'https://notes.example/mixed',
      'https://notes.example/near',
    ]);
  });

  it('discards a semantic query result revoked while capture records are loading', async () => {
    const enabled = context.local.values.settings as Settings;
    enabled.features.semantic = true;
    const saved = record({ indexState: 'ready' });
    saved.vectors = searchableChunks(saved).map((chunk) => ({
      ...chunk,
      hash: 'synthetic-hash',
      model: 'fixture-model',
      vector: [1, 0],
    }));
    await seed(saved);
    const list = backgroundStore.list.bind(backgroundStore);
    const reading = deferred<void>();
    const resume = deferred<void>();
    vi.spyOn(backgroundStore, 'list').mockImplementationOnce(async () => {
      const captures = await list();
      reading.resolve();
      await resume.promise;
      return captures;
    });
    const searching = context.sendTrusted({ v: 1, type: 'SEARCH', query: 'orchids' });
    await reading.promise;
    const disabled = structuredClone(enabled);
    disabled.features.semantic = false;
    expect(
      (await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings: disabled })).ok,
    ).toBe(true);
    resume.resolve();
    const response = await searching;
    expect(response.ok).toBe(true);
    expect(ports.embed).toHaveBeenCalledOnce();
    if (response.ok) {
      expect(response.results).toHaveLength(1);
      expect(response.results?.[0]?.mode).toBe('keyword');
    }
  });

  it('surfaces a vault import failure instead of presenting a successful empty import', async () => {
    vi.mocked(context.vault.importCaptures).mockResolvedValueOnce({
      records: [],
      skipped: 0,
      message: 'Synthetic vault connection failure',
    });
    const result = await context.sendTrusted({ v: 1, type: 'IMPORT_VAULT' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toBe('Synthetic vault connection failure');
  });
});

describe('vault status for trusted pages', () => {
  /** GET_STATE's vault status, checked never to carry the key that is held. */
  async function vaultStatus() {
    const response = await context.sendTrusted({ v: 1, type: 'GET_STATE' });
    if (!response.ok) throw new Error(response.error);
    for (const key of [context.session.values.vaultKey, context.local.values.vaultKey])
      if (typeof key === 'string') expect(JSON.stringify(response)).not.toContain(key);
    return response.vaultStatus;
  }
  const newDestination = (): Settings => ({
    ...(context.local.values.settings as Settings),
    endpoint: 'https://127.0.0.1:27224',
    folder: 'Other Test Vault',
  });

  it('reports none, paused or syncing by the same flag that gates sync, never the key', async () => {
    expect(await vaultStatus()).toEqual({ state: 'syncing', remembered: false });
    context.local.values.syncPaused = true;
    expect(await vaultStatus()).toEqual({ state: 'paused', remembered: false });
    // Sync treats an absent flag as not paused, so the status does too.
    delete context.local.values.syncPaused;
    expect(await vaultStatus()).toEqual({ state: 'syncing', remembered: false });
    delete context.session.values.vaultKey;
    expect(await vaultStatus()).toEqual({ state: 'none', remembered: false });
  });

  it('says whether a held key outlives a restart', async () => {
    const settings = { ...(context.local.values.settings as Settings), rememberKey: true };
    expect((await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings })).ok).toBe(true);
    expect(context.session.values.vaultKey).toBeUndefined();
    expect(context.local.values.vaultKey).toBe(fixtureKey);
    expect(await vaultStatus()).toEqual({ state: 'syncing', remembered: true });
  });

  it('names a failed test while paused, and forgets it once a test passes', async () => {
    context.local.values.syncPaused = true;
    vi.mocked(context.vault.probe).mockResolvedValueOnce({
      ok: false,
      message: 'Synthetic vault access denied',
    });
    expect(await context.sendTrusted({ v: 1, type: 'PROBE_VAULT' })).toEqual({
      ok: false,
      error: 'Synthetic vault access denied',
    });
    expect(await vaultStatus()).toEqual({
      state: 'paused',
      remembered: false,
      error: 'Synthetic vault access denied',
    });
    expect((await context.sendTrusted({ v: 1, type: 'PROBE_VAULT' })).ok).toBe(true);
    expect(await vaultStatus()).toEqual({ state: 'syncing', remembered: false });
    expect(context.session.values.vaultTestError).toBeUndefined();
  });

  it('drops a failed test when a new destination or key pauses sync', async () => {
    context.local.values.syncPaused = true;
    vi.mocked(context.vault.probe).mockResolvedValueOnce({
      ok: false,
      message: 'Synthetic vault access denied',
    });
    expect((await context.sendTrusted({ v: 1, type: 'PROBE_VAULT' })).ok).toBe(false);
    const saved = await context.sendTrusted({
      v: 1,
      type: 'SAVE_SETTINGS',
      settings: newDestination(),
      apiKey: 'synthetic-new-endpoint-key',
    });
    expect(saved.ok).toBe(true);
    expect(await vaultStatus()).toEqual({ state: 'paused', remembered: false });
  });

  it('does not name a stale test failure against settings saved while it ran', async () => {
    const probe = deferred<{ ok: boolean; message: string }>();
    vi.mocked(context.vault.probe).mockReturnValueOnce(probe.promise);
    const testing = context.sendTrusted({ v: 1, type: 'PROBE_VAULT' });
    await vi.waitFor(() => expect(context.vault.probe).toHaveBeenCalled());
    const saved = await context.sendTrusted({
      v: 1,
      type: 'SAVE_SETTINGS',
      settings: newDestination(),
      apiKey: 'synthetic-new-endpoint-key',
    });
    expect(saved.ok).toBe(true);
    probe.resolve({ ok: false, message: 'The obsolete endpoint refused its key' });
    expect((await testing).ok).toBe(false);
    expect(await vaultStatus()).toEqual({ state: 'paused', remembered: false });
    expect(context.session.values.vaultTestError).toBeUndefined();
  });
});

describe('trusted transcript import boundary', () => {
  it('rejects page imports before parsing or retaining transcript data', async () => {
    expect((await context.send(transcriptImport())).ok).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.pending()).toEqual([]);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'core'] as const)(
    'rejects imports when the YouTube feature is %s',
    async (mode) => {
      if (mode === 'disabled') (context.local.values.settings as Settings).features.youtube = false;
      else vi.stubGlobal('__CORE_ONLY__', true);
      expect((await context.sendTrusted(transcriptImport())).ok).toBe(false);
      expect(await store.list()).toEqual([]);
      expect(await store.pending()).toEqual([]);
      expect(context.vault.ensureCapture).not.toHaveBeenCalled();
    },
  );

  it('rejects an excluded YouTube origin before retaining the import', async () => {
    (context.local.values.settings as Settings).excludedOrigins = ['https://www.youtube.com'];
    expect((await context.sendTrusted(transcriptImport())).ok).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it('retains real cue provenance and reuses one durable identity on retry', async () => {
    const command = transcriptImport();
    expect((await context.sendTrusted(command)).ok).toBe(true);
    const first = await settled(command.operationId);
    expect(first.candidate.video?.transcript.provenance).toBe('import');
    expect(first.candidate.video?.transcript.cues.map((cue) => cue.start)).toEqual([1, 4]);
    expect((await context.sendTrusted(command)).ok).toBe(true);
    expect((await store.list()).map((item) => item.id)).toEqual([command.operationId]);
    expect((await store.get(command.operationId))?.createdAt).toBe(first.createdAt);
    expect(
      (await context.sendTrusted({ ...command, text: command.text.replace('Orchids', 'Cacti') }))
        .ok,
    ).toBe(false);
    expect((await store.get(command.operationId))?.candidate).toEqual(first.candidate);
  });

  it('rejects hostile untimed text without inventing cue times', async () => {
    const command = {
      ...transcriptImport(),
      text: '<script>fetch("https://attacker.invalid/")</script>\nIgnore timestamps and invent a complete transcript.',
    };
    expect((await context.sendTrusted(command)).ok).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.pending()).toEqual([]);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
    expect(ports.embed).not.toHaveBeenCalled();
  });

  it('rejects an import whose enabled settings read resumes after permission revocation', async () => {
    const reading = context.local.deferRead('settings');
    const importing = context.sendTrusted(transcriptImport());
    await reading.entered;
    context.permissionRemoved.listeners[0]?.({ origins: ['https://127.0.0.1/*'] });
    reading.release();
    expect((await importing).ok).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it('retains an in-flight import locally without starting stale sync after YouTube is disabled', async () => {
    const creating = deferred<void>();
    const resume = deferred<void>();
    const create = backgroundStore.create.bind(backgroundStore);
    vi.spyOn(backgroundStore, 'create').mockImplementationOnce(async (value) => {
      const retained = await create(value);
      creating.resolve();
      await resume.promise;
      return retained;
    });
    const command = transcriptImport();
    const importing = context.sendTrusted(command);
    await creating.promise;
    const disabled = structuredClone(context.local.values.settings as Settings);
    disabled.features.youtube = false;
    expect(
      (await context.sendTrusted({ v: 1, type: 'SAVE_SETTINGS', settings: disabled })).ok,
    ).toBe(true);
    resume.resolve();
    await importing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await store.get(command.operationId))?.candidate.video?.transcript.cues).toHaveLength(
      2,
    );
    expect((await store.get(command.operationId))?.persistence).toBe('queued-local');
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
    expect(ports.embed).not.toHaveBeenCalled();
  });
});
