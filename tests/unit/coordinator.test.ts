import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptureStore } from '../../src/adapters/persistence/indexed-db';
import { createCoordinator } from '../../src/application/coordinator';
import {
  defaultSettings,
  type CaptureCandidate,
  type CaptureRecord,
  type VaultImportResult,
  type VaultRepository,
  type VaultSaveResult,
  type VaultUnavailableCapture,
} from '../../src/core/contracts';

const text: CaptureCandidate = {
  kind: 'text',
  title: 'A thought',
  url: 'https://example.com/source',
  text: 'Dogs play with tennis balls in the park.',
};
const stores: ReturnType<typeof createCaptureStore>[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup(
  options: {
    vault?: VaultRepository;
    semantic?: boolean;
    embed?: (text: string, signal?: AbortSignal) => Promise<number[]>;
    name?: string;
  } = {},
) {
  const store = createCaptureStore(options.name ?? `test-${crypto.randomUUID()}`);
  stores.push(store);
  const vault: VaultRepository = options.vault ?? {
    ensureCapture: vi.fn(async () => ({ status: 'saved-vault' as const })),
    syncLifecycle: vi.fn(async () => ({ status: 'saved-vault' as const })),
    probe: async () => ({ ok: true, message: 'fixture' }),
    importCaptures: async () => ({ records: [], skipped: 0 }),
  };
  const coordinator = createCoordinator({
    store,
    vault: async () => vault,
    embedder: { id: 'fixture-model', embed: options.embed ?? (async () => [1, 0]) },
    features: async () => ({ ...defaultSettings.features, semantic: options.semantic ?? false }),
  });
  return { store, vault, coordinator };
}
async function cachedCapture(
  context: ReturnType<typeof setup>,
  overrides: Partial<CaptureRecord> = {},
) {
  const record = await context.coordinator.capture(text, crypto.randomUUID());
  const vault = {
    notePath: `Zombie Hand/captures/${record.id}.md`,
    metadataPath: `Zombie Hand/metadata/${record.id}.json`,
    metadataEtag: '"cached-version"',
  };
  await context.store.settle(record.id, record.lifecycleRevision, { status: 'saved-vault', vault });
  return context.store.update(record.id, (current) => ({ ...current, ...overrides }), false);
}
function unavailable(record: CaptureRecord): VaultUnavailableCapture {
  if (!record.vault) throw new Error('Synthetic saved capture requires generated paths');
  return {
    id: record.id,
    operationId: record.operationId,
    contentRevision: record.contentRevision,
    lifecycleRevision: record.lifecycleRevision,
    notePath: record.vault.notePath,
    metadataPath: record.vault.metadataPath,
    reason: 'missing',
    message: 'Synthetic confirmed missing note; cached evidence retained.',
  };
}
function recovered(
  record: CaptureRecord,
  lifecycle: 'active' | 'archived' = 'archived',
): CaptureRecord {
  return {
    ...record,
    lifecycle,
    lifecycleRevision: record.lifecycleRevision + 1,
    updatedAt: new Date(Date.parse(record.updatedAt) + 1000).toISOString(),
    vault: {
      notePath: `Zombie Hand/captures/${record.id}.md`,
      metadataPath: `Zombie Hand/metadata/${record.id}.json`,
      metadataEtag: '"remote-version"',
    },
  };
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe('durable capture coordinator', () => {
  it('commits evidence and pending operation together before any vault call', async () => {
    const { store, vault, coordinator } = setup();
    const record = await coordinator.capture(text, crypto.randomUUID());
    expect(record.persistence).toBe('queued-local');
    expect(await store.pending()).toHaveLength(1);
    expect(vault.ensureCapture).not.toHaveBeenCalled();
    await coordinator.sync(record.id);
    expect((await store.get(record.id))?.persistence).toBe('saved-vault');
    expect(await store.pending()).toHaveLength(0);
  });
  it('keeps capture creation idempotent and rejects identity reuse for different evidence', async () => {
    const { coordinator, store } = setup();
    const id = crypto.randomUUID();
    await coordinator.capture(text, id);
    await coordinator.capture(text, id);
    expect(await store.list()).toHaveLength(1);
    await expect(coordinator.capture({ ...text, text: 'Different text' }, id)).rejects.toThrow(
      'different evidence',
    );
  });
  it('does not publish media until durable preparation has finished, even under Retry', async () => {
    const { coordinator, vault, store } = setup();
    const record = await coordinator.capture(text, crypto.randomUUID(), undefined, 'link', true);
    await coordinator.drain(true);
    expect(vault.ensureCapture).not.toHaveBeenCalled();
    await store.update(record.id, (current) => ({ ...current, preparation: 'ready' }));
    await coordinator.sync(record.id);
    expect(vault.ensureCapture).toHaveBeenCalledOnce();
  });
  it('recovers interrupted preparation as an honest link when the worker restarts', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const first = setup({ name });
    const record = await first.coordinator.capture(
      text,
      crypto.randomUUID(),
      undefined,
      'link',
      true,
    );
    await first.store.close();
    const second = setup({ name });
    await second.coordinator.recoverPreparation();
    await second.coordinator.drain(true);
    expect((await second.store.get(record.id))?.preservation).toBe('link');
    expect((await second.store.get(record.id))?.preparation).toBe('ready');
    expect(second.vault.ensureCapture).toHaveBeenCalledOnce();
  });
  it('serializes concurrent writes for the same capture', async () => {
    const gate = deferred<VaultSaveResult>();
    const { coordinator, vault } = setup();
    vi.mocked(vault.ensureCapture).mockReturnValue(gate.promise);
    const record = await coordinator.capture(text, crypto.randomUUID());
    const first = coordinator.sync(record.id);
    const second = coordinator.sync(record.id);
    await vi.waitFor(() => expect(vault.ensureCapture).toHaveBeenCalledOnce());
    gate.resolve({ status: 'saved-vault' });
    await Promise.all([first, second]);
    expect(vault.ensureCapture).toHaveBeenCalledOnce();
  });
  it('reconciles a late successful save to the latest archived lifecycle', async () => {
    const gate = deferred<VaultSaveResult>();
    const { coordinator, vault, store } = setup();
    vi.mocked(vault.ensureCapture).mockReturnValueOnce(gate.promise);
    const record = await coordinator.capture(text, crypto.randomUUID());
    const saving = coordinator.sync(record.id);
    await vi.waitFor(() => expect(vault.ensureCapture).toHaveBeenCalledOnce());
    await coordinator.lifecycle(record.id, 'archived');
    gate.resolve({ status: 'saved-vault' });
    await saving;
    expect(vault.ensureCapture).toHaveBeenCalledTimes(2);
    expect(vi.mocked(vault.ensureCapture).mock.calls[1]?.[0].lifecycle).toBe('archived');
    expect((await store.get(record.id))?.lifecycle).toBe('archived');
    expect((await store.get(record.id))?.persistence).toBe('saved-vault');
    expect(await coordinator.search('Dogs')).toEqual([]);
  });
  it('retains uncertain jobs over restart and retries without changing capture identity', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const first = setup({ name });
    vi.mocked(first.vault.ensureCapture).mockResolvedValue({
      status: 'uncertain',
      message: 'Fixture dropped response',
    });
    const record = await first.coordinator.capture(text, crypto.randomUUID());
    await first.coordinator.sync(record.id);
    expect(await first.store.pending()).toHaveLength(1);
    await first.store.close();
    const second = setup({ name });
    await second.coordinator.drain(true);
    expect((await second.store.get(record.id))?.persistence).toBe('saved-vault');
    expect(await second.store.pending()).toHaveLength(0);
  });
  it('does not auto-retry conflicts or include them in retrieval', async () => {
    const { coordinator, vault, store } = setup();
    vi.mocked(vault.ensureCapture).mockResolvedValue({
      status: 'conflict',
      message: 'Fixture manual edit',
    });
    const record = await coordinator.capture(text, crypto.randomUUID());
    await coordinator.sync(record.id);
    await coordinator.drain();
    expect(vault.ensureCapture).toHaveBeenCalledOnce();
    expect(await store.pending()).toEqual([]);
    expect(await coordinator.search('Dogs')).toEqual([]);
  });
  it('discards an embedding that finishes after archive and never revives the capture', async () => {
    const gate = deferred<number[]>();
    const embed = vi.fn(() => gate.promise);
    const { coordinator, store } = setup({ semantic: true, embed });
    const record = await coordinator.capture(text, crypto.randomUUID());
    await coordinator.sync(record.id);
    await vi.waitFor(() => expect(embed).toHaveBeenCalled());
    await coordinator.lifecycle(record.id, 'archived');
    gate.resolve([1, 0]);
    await vi.waitFor(async () => expect((await store.get(record.id))?.lifecycle).toBe('archived'));
    expect((await store.get(record.id))?.vectors).toBeUndefined();
  });
  it('discards model results after a feature epoch is revoked', async () => {
    const gate = deferred<number[]>();
    const embed = vi.fn(() => gate.promise);
    const { coordinator, store } = setup({ semantic: true, embed });
    const record = await coordinator.capture(text, crypto.randomUUID());
    await coordinator.sync(record.id);
    await vi.waitFor(() => expect(embed).toHaveBeenCalled());
    coordinator.disableJobs();
    gate.resolve([1, 0]);
    await Promise.resolve();
    expect((await store.get(record.id))?.vectors).toBeUndefined();
  });
  it('names keyword fallback honestly when semantic inference fails', async () => {
    const { coordinator } = setup({
      semantic: true,
      embed: async () => {
        throw new Error('Fixture unavailable');
      },
    });
    const record = await coordinator.capture(text, crypto.randomUUID());
    await coordinator.sync(record.id);
    const results = await coordinator.search('tennis');
    expect(results).toHaveLength(1);
    expect(results[0]?.mode).toBe('keyword');
  });
  it('preserves pending archive operations when vault recovery contains an older active record', async () => {
    const { coordinator, store } = setup();
    const record = await coordinator.capture(text, crypto.randomUUID());
    await store.update(record.id, (current) => ({
      ...current,
      lifecycle: 'archived',
      lifecycleRevision: 1,
    }));
    expect(
      await store.import([{ ...record, lifecycle: 'active', persistence: 'saved-vault' }]),
    ).toBe(0);
    expect((await store.get(record.id))?.lifecycle).toBe('archived');
    expect(await store.pending()).toHaveLength(1);
  });
  it('preserves unknown namespaced metadata through lifecycle changes', async () => {
    const { coordinator, store } = setup();
    const record = await coordinator.capture(text, crypto.randomUUID());
    await store.update(record.id, (current) => ({
      ...current,
      metadata: { 'removed-feature': { value: 'retained' } },
    }));
    await coordinator.lifecycle(record.id, 'archived');
    await coordinator.sync(record.id);
    expect((await store.get(record.id))?.metadata).toEqual({
      'removed-feature': { value: 'retained' },
    });
  });
  it('keeps the journal when a stale acknowledgement races a newer local revision', async () => {
    const { store, coordinator } = setup();
    const record = await coordinator.capture(text, crypto.randomUUID());
    await store.update(record.id, (current) => ({
      ...current,
      lifecycle: 'archived',
      lifecycleRevision: 2,
    }));
    const settled = await store.settle(record.id, 0, { status: 'saved-vault' });
    expect(settled.lifecycleRevision).toBe(2);
    expect(settled.persistence).toBe('queued-local');
    expect(await store.pending()).toHaveLength(1);
  });
  it('surfaces missing vault configuration while retaining evidence', async () => {
    const { store } = setup();
    const coordinator = createCoordinator({
      store,
      vault: async () => undefined,
      features: async () => defaultSettings.features,
      embedder: { id: 'unused', embed: async () => [1] },
    });
    const record = await coordinator.capture(text, crypto.randomUUID());
    await coordinator.sync(record.id);
    const saved = await store.get(record.id);
    expect(saved?.candidate).toEqual(text);
    expect(saved?.persistence).toBe('failed');
    expect(saved?.lastError).toContain('retained locally');
  });
  it('retries a failed semantic index only on explicit recovery and preserves source evidence', async () => {
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic model unavailable'))
      .mockResolvedValue([1, 0]);
    const context = setup({ semantic: true, embed });
    const record = await cachedCapture(context);
    await context.coordinator.index(record.id);
    expect((await context.store.get(record.id))?.indexState).toBe('failed');
    await context.coordinator.drain();
    expect(embed).toHaveBeenCalledOnce();
    await context.coordinator.drain(true);
    await vi.waitFor(async () =>
      expect((await context.store.get(record.id))?.indexState).toBe('ready'),
    );
    const indexed = await context.store.get(record.id);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(indexed?.candidate).toEqual(record.candidate);
    expect(indexed?.persistence).toBe('saved-vault');
    expect(indexed?.indexError).toBeUndefined();
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });
});

describe('vault recovery reconciles only observed and unchanged evidence', () => {
  it('quarantines a missing note once, whichever of its two names it was saved under', async () => {
    for (const name of ['id', 'readable'] as const) {
      const context = setup();
      const saved = await cachedCapture(context);
      const paths = {
        id: saved.vault?.notePath ?? '',
        readable: `Zombie Hand/captures/A passage (${saved.id.slice(0, 8)}).md`,
      };
      const record =
        name === 'id'
          ? saved
          : await context.store.update(
              saved.id,
              (current) => ({
                ...current,
                vault: current.vault && { ...current.vault, notePath: paths.readable },
              }),
              false,
            );
      // The vault cannot tell which name the note had, so it reports the absence under both.
      const observation = unavailable(record);
      vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({
        records: [],
        skipped: 1,
        unavailable: [
          { ...observation, notePath: paths.readable },
          { ...observation, notePath: paths.id },
        ],
      });
      expect(await context.coordinator.importVault()).toMatchObject({ quarantined: 1 });
      expect((await context.store.get(record.id))?.persistence).toBe('conflict');
    }
  });
  it('quarantines confirmed missing captures without deleting evidence or creating a remote job', async () => {
    const context = setup();
    const record = await cachedCapture(context, {
      metadata: { 'removed-feature': { preserved: true } },
    });
    vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({
      records: [],
      skipped: 1,
      unavailable: [unavailable(record)],
    });
    expect(await context.coordinator.importVault()).toMatchObject({ count: 0, quarantined: 1 });
    const retained = await context.store.get(record.id);
    expect(retained).toMatchObject({
      candidate: record.candidate,
      metadata: record.metadata,
      lifecycle: 'active',
      persistence: 'conflict',
      indexState: 'disabled',
    });
    expect(await context.coordinator.search('Dogs')).toEqual([]);
    expect(await context.store.pending()).toEqual([]);
    await context.coordinator.drain(true);
    expect(context.vault.ensureCapture).not.toHaveBeenCalled();
  });

  it.each(['operation', 'content', 'path'] as const)(
    'does not quarantine an observation with a different %s identity',
    async (kind) => {
      const context = setup();
      const record = await cachedCapture(context);
      const observation = unavailable(record);
      if (kind === 'operation') observation.operationId = crypto.randomUUID();
      if (kind === 'content') observation.contentRevision++;
      if (kind === 'path') observation.metadataPath = `Other Vault/metadata/${record.id}.json`;
      vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({
        records: [],
        skipped: 1,
        unavailable: [observation],
      });
      expect((await context.coordinator.importVault()).quarantined).toBe(0);
      expect(await context.store.get(record.id)).toEqual(record);
      expect(await context.coordinator.search('Dogs')).toHaveLength(1);
    },
  );

  it('does not turn failed or bounded scan omissions into missing cached records', async () => {
    const context = setup();
    const record = await cachedCapture(context);
    vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({
      records: [],
      skipped: 200,
      message: 'Synthetic scan stopped at a resource bound.',
    });
    expect((await context.coordinator.importVault()).quarantined).toBe(0);
    expect(await context.store.get(record.id)).toEqual(record);
    expect(await context.coordinator.search('Dogs')).toHaveLength(1);
  });

  it.each(['before', 'during'] as const)(
    'preserves an archive queued %s recovery over negative observations and newer remote lifecycle',
    async (when) => {
      const context = setup();
      const record = await cachedCapture(context);
      const response = {
        records: [recovered(record, 'active')],
        skipped: 1,
        unavailable: [unavailable(record)],
      };
      const entered = deferred<void>();
      const gate = deferred<VaultImportResult>();
      vi.spyOn(context.vault, 'importCaptures').mockImplementation(async () => {
        entered.resolve();
        return gate.promise;
      });
      const archive = () =>
        context.store.update(record.id, (current) => ({
          ...current,
          lifecycle: 'archived',
          lifecycleRevision: 1,
          persistence: 'queued-local',
          indexState: 'disabled',
        }));
      if (when === 'before') await archive();
      const importing = context.coordinator.importVault();
      await entered.promise;
      if (when === 'during') await archive();
      gate.resolve(response);
      expect((await importing).quarantined).toBe(0);
      expect(await context.store.get(record.id)).toMatchObject({
        lifecycle: 'archived',
        lifecycleRevision: 1,
        persistence: 'queued-local',
      });
      expect(await context.store.pending()).toHaveLength(1);
      expect(await context.coordinator.search('Dogs')).toEqual([]);
      expect(context.vault.ensureCapture).not.toHaveBeenCalled();
    },
  );

  it.each(['archived', 'active'] as const)(
    'adopts a verified newer %s lifecycle without replacing locally retained source or metadata',
    async (lifecycle) => {
      const context = setup();
      const record = await cachedCapture(context, {
        lifecycle: lifecycle === 'archived' ? 'active' : 'archived',
        lifecycleRevision: 3,
        metadata: { local: { retained: true } },
      });
      const remote = { ...recovered(record, lifecycle), metadata: { remote: { separate: true } } };
      vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({
        records: [remote],
        skipped: 0,
      });
      expect((await context.coordinator.importVault()).count).toBe(0);
      expect(await context.store.get(record.id)).toMatchObject({
        candidate: record.candidate,
        metadata: record.metadata,
        lifecycle,
        lifecycleRevision: 4,
        vault: remote.vault,
      });
      expect(await context.coordinator.search('Dogs')).toHaveLength(
        lifecycle === 'archived' ? 0 : 1,
      );
      expect(await context.store.pending()).toEqual([]);
      expect(context.vault.ensureCapture).not.toHaveBeenCalled();
    },
  );

  it('does not adopt a remote lifecycle whose source differs from the cached immutable capture', async () => {
    const context = setup();
    const record = await cachedCapture(context);
    const remote = {
      ...recovered(record),
      candidate: { ...record.candidate, text: 'Different source evidence' },
    };
    vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({ records: [remote], skipped: 0 });
    await context.coordinator.importVault();
    expect(await context.store.get(record.id)).toEqual(record);
  });

  it('rejects late recovery observations after the configuration epoch was revoked', async () => {
    const context = setup();
    const record = await cachedCapture(context);
    const entered = deferred<void>();
    const gate = deferred<VaultImportResult>();
    vi.spyOn(context.vault, 'importCaptures').mockImplementation(async () => {
      entered.resolve();
      return gate.promise;
    });
    const importing = context.coordinator.importVault();
    await entered.promise;
    context.coordinator.disableJobs();
    gate.resolve({ records: [recovered(record)], skipped: 1, unavailable: [unavailable(record)] });
    await expect(importing).rejects.toThrow('configuration changed');
    expect(await context.store.get(record.id)).toEqual(record);
  });

  it('checks recovery authorization inside the actual new-record transaction callback', async () => {
    const context = setup();
    const id = crypto.randomUUID();
    const record: CaptureRecord = {
      schemaVersion: 1,
      id,
      operationId: id,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      candidate: text,
      lifecycle: 'active',
      lifecycleRevision: 0,
      contentRevision: 0,
      persistence: 'saved-vault',
      preservation: 'text',
      indexState: 'pending',
    };
    vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({ records: [record], skipped: 0 });
    const importRecords = context.store.import.bind(context.store);
    vi.spyOn(context.store, 'import').mockImplementation((records, accept) =>
      importRecords(records, () => {
        context.coordinator.disableJobs();
        return accept?.() ?? true;
      }),
    );
    expect((await context.coordinator.importVault()).count).toBe(0);
    expect(await context.store.get(id)).toBeUndefined();
    expect(await context.store.pending()).toEqual([]);
  });

  it('rejects quarantine when revocation happens inside the final durable mutation callback', async () => {
    const context = setup();
    const record = await cachedCapture(context);
    vi.spyOn(context.vault, 'importCaptures').mockResolvedValue({
      records: [],
      skipped: 1,
      unavailable: [unavailable(record)],
    });
    const update = context.store.update.bind(context.store);
    vi.spyOn(context.store, 'update').mockImplementation((id, change, queue) =>
      update(
        id,
        (current) => {
          context.coordinator.disableJobs();
          return change(current);
        },
        queue,
      ),
    );
    expect((await context.coordinator.importVault()).quarantined).toBe(0);
    expect(await context.store.get(record.id)).toEqual(record);
  });
});

describe('versioned local records', () => {
  it('preserves malformed and future jobs while allowing later compatible captures to sync', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const { store, coordinator, vault } = setup({ name });
    const futureId = '00000000-0000-4000-8000-000000000001';
    const compatibleId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const original = await coordinator.capture(text, futureId);
    await coordinator.capture(text, compatibleId);
    const open = indexedDB.open(name, 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    try {
      const future = { ...original, schemaVersion: 99 };
      const malformed = { captureId: '000-invalid-job', attempts: -1, nextAttemptAt: 'unknown' };
      const tx = db.transaction(['captures', 'operations'], 'readwrite');
      tx.objectStore('captures').put(future);
      tx.objectStore('operations').put(malformed);
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
      });
      expect((await store.pending()).map((job) => job.captureId)).toEqual([futureId, compatibleId]);
      await coordinator.drain(true);
      expect(vault.ensureCapture).toHaveBeenCalledOnce();
      expect(vi.mocked(vault.ensureCapture).mock.calls[0]?.[0].id).toBe(compatibleId);
      expect((await store.get(compatibleId))?.persistence).toBe('saved-vault');
      expect(await store.exportRecords()).toContainEqual(future);
      expect((await store.pending()).map((job) => job.captureId)).toEqual([futureId]);
      const request = db
        .transaction('operations')
        .objectStore('operations')
        .get(malformed.captureId);
      const retained = await new Promise<unknown>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      expect(retained).toEqual(malformed);
    } finally {
      db.close();
    }
  });

  it('does not downgrade future records on list or import', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const { store, coordinator } = setup({ name });
    const record = await coordinator.capture(text, crypto.randomUUID());
    const open = indexedDB.open(name, 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    const tx = db.transaction('captures', 'readwrite');
    const unknown = { ...record, id: crypto.randomUUID(), schemaVersion: 99 };
    tx.objectStore('captures').put(unknown);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    expect(await store.list()).toHaveLength(1);
    const reading = db.transaction('captures').objectStore('captures').get(unknown.id);
    const retained = await new Promise<CaptureRecord>((resolve) => {
      reading.onsuccess = () => resolve(reading.result as CaptureRecord);
    });
    expect(retained.schemaVersion).toBe(99);
    expect(await store.exportRecords()).toContainEqual(unknown);
    await expect(store.create({ ...record, id: unknown.id })).rejects.toThrow();
    db.close();
  });
});
