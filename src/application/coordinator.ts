import type {
  CaptureCandidate,
  CaptureRecord,
  CaptureRepository,
  Embedder,
  Features,
  SearchResult,
  VaultRepository,
} from '../core/contracts';
import { noVaultMessage } from '../core/contracts';
import {
  contentHash,
  cosine,
  keywordScore,
  publicCapture,
  searchableChunks,
} from '../core/domain/retrieval';

export interface CoordinatorDependencies {
  store: CaptureRepository;
  vault: () => Promise<VaultRepository | undefined>;
  embedder: Embedder;
  features: () => Promise<Features>;
  changed?: (record: CaptureRecord) => void;
}
export function createCoordinator(deps: CoordinatorDependencies) {
  const writers = new Map<string, Promise<void>>();
  const indexing = new Map<string, AbortController>();
  let featureEpoch = 0;
  const notify = (record: CaptureRecord) => {
    deps.changed?.(record);
    return record;
  };
  async function sync(id: string): Promise<void> {
    const existing = writers.get(id);
    if (existing) return existing;
    const run = (async () => {
      for (let pass = 0; pass < 6; pass++) {
        const record = await deps.store.get(id);
        if (!record || record.preparation === 'pending') return;
        const vault = await deps.vault();
        const saved = vault
          ? await vault.ensureCapture(record)
          : { status: 'failed' as const, message: noVaultMessage };
        const latest = notify(await deps.store.settle(id, record.lifecycleRevision, saved));
        if (latest.lifecycleRevision !== record.lifecycleRevision) continue;
        if (saved.status === 'saved-vault' && latest.lifecycle === 'active') void index(id);
        break;
      }
    })().finally(() => writers.delete(id));
    writers.set(id, run);
    return run;
  }
  async function index(id: string): Promise<void> {
    const epoch = featureEpoch;
    if (indexing.has(id)) return;
    const features = await deps.features();
    if (epoch !== featureEpoch || !features.semantic) return;
    const record = await deps.store.get(id);
    if (
      epoch !== featureEpoch ||
      indexing.has(id) ||
      record?.lifecycle !== 'active' ||
      record.persistence !== 'saved-vault'
    )
      return;
    const controller = new AbortController();
    indexing.set(id, controller);
    try {
      const vectors: NonNullable<CaptureRecord['vectors']> = [];
      for (const chunk of searchableChunks(record)) {
        if (controller.signal.aborted) return;
        const hash = await contentHash(`${deps.embedder.id}\n${chunk.text}`);
        const cached = record.vectors?.find(
          (vector) => vector.hash === hash && vector.model === deps.embedder.id,
        );
        vectors.push(
          cached ?? {
            model: deps.embedder.id,
            hash,
            ...chunk,
            vector: await deps.embedder.embed(chunk.text, controller.signal),
          },
        );
      }
      if (controller.signal.aborted || epoch !== featureEpoch) return;
      notify(
        await deps.store.update(
          id,
          (current) =>
            !controller.signal.aborted &&
            epoch === featureEpoch &&
            current.lifecycle === 'active' &&
            current.contentRevision === record.contentRevision
              ? { ...current, vectors, indexState: 'ready', indexError: undefined }
              : current,
          false,
        ),
      );
    } catch {
      if (!controller.signal.aborted && epoch === featureEpoch)
        notify(
          await deps.store.update(
            id,
            (current) =>
              controller.signal.aborted || epoch !== featureEpoch
                ? current
                : {
                    ...current,
                    indexState: 'failed',
                    indexError: 'Local semantic model unavailable. Keyword search still works.',
                  },
            false,
          ),
        );
    } finally {
      indexing.delete(id);
    }
  }
  return {
    async capture(
      candidate: CaptureCandidate,
      operationId: string,
      asset?: CaptureRecord['asset'],
      preservation?: CaptureRecord['preservation'],
      preparing = false,
    ) {
      const now = new Date().toISOString();
      const record: CaptureRecord = {
        schemaVersion: 1,
        id: operationId,
        operationId,
        createdAt: now,
        updatedAt: now,
        candidate,
        lifecycle: 'active',
        lifecycleRevision: 0,
        contentRevision: 0,
        persistence: 'queued-local',
        preparation: preparing ? 'pending' : 'ready',
        preservation: preservation ?? (candidate.kind === 'text' ? 'text' : 'link'),
        indexState: 'pending',
        ...(asset ? { asset } : {}),
      };
      return notify(await deps.store.create(record));
    },
    sync,
    index,
    async recoverPreparation() {
      for (const record of await deps.store.list())
        if (record.preparation === 'pending')
          await deps.store.update(record.id, (current) => ({
            ...current,
            preparation: 'ready',
            preservation: 'link',
            lastError:
              'Media preparation was interrupted. The source link was preserved; capture again to retain image bytes.',
          }));
    },
    async lifecycle(id: string, lifecycle: 'active' | 'archived') {
      indexing.get(id)?.abort();
      const record = await deps.store.update(id, (current) => ({
        ...current,
        lifecycle,
        lifecycleRevision: current.lifecycleRevision + 1,
        updatedAt: new Date().toISOString(),
        persistence: 'queued-local',
        indexState: lifecycle === 'archived' ? 'disabled' : 'pending',
      }));
      notify(record);
      void sync(id);
      return record;
    },
    async drain(force = false) {
      for (const pending of await deps.store.pending()) {
        if (force || pending.nextAttemptAt <= Date.now()) {
          // Unsupported future records retain their journal; one unreadable item
          // must not prevent compatible captures from making progress.
          try {
            await sync(pending.captureId);
          } catch {
            /* Keep the durable job and continue. */
          }
        }
      }
      for (const record of await deps.store.list())
        if (
          record.lifecycle === 'active' &&
          record.persistence === 'saved-vault' &&
          (record.indexState === 'pending' || (force && record.indexState === 'failed'))
        )
          void index(record.id);
    },
    async search(query: string): Promise<SearchResult[]> {
      const epoch = featureEpoch;
      const trimmed = query.trim().slice(0, 2000);
      const features = await deps.features();
      let queryVector: number[] | undefined;
      if (trimmed && features.semantic && epoch === featureEpoch) {
        try {
          queryVector = await deps.embedder.embed(trimmed);
          if (epoch !== featureEpoch) queryVector = undefined;
        } catch {
          /* Explicit keyword fallback below. */
        }
      }
      const records = await deps.store.list();
      const results: SearchResult[] = [];
      if (epoch !== featureEpoch) queryVector = undefined;
      for (const record of records) {
        if (record.lifecycle !== 'active' || record.persistence !== 'saved-vault') continue;
        let best: SearchResult | undefined;
        for (const chunk of searchableChunks(record)) {
          const indexed = record.vectors?.find(
            (vector) => vector.text === chunk.text && vector.model === deps.embedder.id,
          );
          const semantic = !!(queryVector && indexed);
          const score = !trimmed
            ? 1
            : semantic
              ? cosine(queryVector ?? [], indexed?.vector ?? [])
              : keywordScore(trimmed, chunk.text);
          if (score > 0 && (!best || score > best.score))
            best = {
              capture: publicCapture(record),
              excerpt: chunk.text,
              sourceUrl: chunk.sourceUrl,
              mode: semantic ? 'semantic' : 'keyword',
              score,
            };
        }
        if (best) results.push(best);
      }
      return results.sort((a, b) => b.score - a.score).slice(0, 20);
    },
    disableJobs() {
      featureEpoch++;
      for (const controller of indexing.values()) controller.abort();
    },
    async importVault() {
      const epoch = featureEpoch;
      const vault = await deps.vault();
      if (!vault) throw new Error('Connect a vault first.');
      const baseline = new Map(
        (await deps.store.list())
          .filter((record) => record.persistence === 'saved-vault')
          .map((record) => [record.id, record]),
      );
      const imported = await vault.importCaptures();
      if (epoch !== featureEpoch) throw new Error('Vault configuration changed during recovery.');
      const count = await deps.store.import(imported.records, () => epoch === featureEpoch);
      let quarantined = 0;
      const unchanged = (current: CaptureRecord, previous: CaptureRecord) =>
        epoch === featureEpoch &&
        current.persistence === 'saved-vault' &&
        current.operationId === previous.operationId &&
        current.contentRevision === previous.contentRevision &&
        current.lifecycleRevision === previous.lifecycleRevision &&
        current.updatedAt === previous.updatedAt;
      for (const unavailable of imported.unavailable ?? []) {
        const previous = baseline.get(unavailable.id);
        if (
          !previous ||
          previous.operationId !== unavailable.operationId ||
          previous.contentRevision !== unavailable.contentRevision ||
          previous.vault?.notePath !== unavailable.notePath ||
          previous.vault?.metadataPath !== unavailable.metadataPath
        )
          continue;
        indexing.get(previous.id)?.abort();
        const current = await deps.store.update(
          previous.id,
          (record) => {
            if (!unchanged(record, previous)) return record;
            quarantined++;
            return {
              ...record,
              persistence: 'conflict',
              indexState: 'disabled',
              lastError: unavailable.message,
            };
          },
          false,
        );
        notify(current);
      }
      for (const remote of imported.records) {
        const previous = baseline.get(remote.id);
        if (
          previous?.vault &&
          remote.vault &&
          remote.lifecycleRevision > previous.lifecycleRevision &&
          remote.operationId === previous.operationId &&
          remote.contentRevision === previous.contentRevision &&
          remote.vault.notePath === previous.vault.notePath &&
          remote.vault.metadataPath === previous.vault.metadataPath &&
          JSON.stringify(remote.candidate) === JSON.stringify(previous.candidate)
        ) {
          indexing.get(remote.id)?.abort();
          notify(
            await deps.store.update(
              remote.id,
              (current) =>
                unchanged(current, previous)
                  ? {
                      ...current,
                      lifecycle: remote.lifecycle,
                      lifecycleRevision: remote.lifecycleRevision,
                      updatedAt: remote.updatedAt,
                      vault: remote.vault,
                      indexState: remote.lifecycle === 'archived' ? 'disabled' : 'pending',
                    }
                  : current,
              false,
            ),
          );
        }
        if (epoch === featureEpoch) void index(remote.id);
      }
      return {
        count,
        skipped: imported.skipped,
        quarantined,
        message:
          imported.message ??
          `Imported ${count} new captures; quarantined ${quarantined} missing or changed captures; skipped ${imported.skipped} unsupported or inconsistent records.`,
      };
    },
  };
}
