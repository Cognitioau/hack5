import {
  captureRecordSchema,
  pendingOperationSchema,
  type CaptureRecord,
  type CaptureRepository,
  type PendingOperation,
  type VaultSaveResult,
} from '../../core/contracts';

const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed'));
  });
const completed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('Local storage transaction failed'));
  });

export function createCaptureStore(
  name = 'zombie-hand-v1',
): CaptureRepository & { close(): Promise<void> } {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('captures', { keyPath: 'id' });
        request.result.createObjectStore('operations', { keyPath: 'captureId' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Cannot open local capture storage'));
      request.onblocked = () =>
        reject(new Error('Close other Zombie Brain pages to upgrade storage'));
    }));
  async function mutate<T>(
    fn: (
      records: IDBObjectStore,
      jobs: IDBObjectStore,
      resolve: (value: T) => void,
      reject: (reason: unknown) => void,
    ) => void,
  ): Promise<T> {
    const db = await open();
    const tx = db.transaction(['captures', 'operations'], 'readwrite');
    const done = completed(tx);
    let value: T | undefined;
    let problem: unknown;
    fn(
      tx.objectStore('captures'),
      tx.objectStore('operations'),
      (v) => {
        value = v;
      },
      (e) => {
        problem = e;
        tx.abort();
      },
    );
    try {
      await done;
    } catch (e) {
      throw problem ?? e;
    }
    return value as T;
  }
  return {
    async create(record) {
      const valid = captureRecordSchema.parse(record);
      return mutate<CaptureRecord>((records, jobs, resolve, reject) => {
        const read = records.get(valid.id);
        read.onsuccess = () => {
          try {
            if (read.result) {
              const previous = captureRecordSchema.parse(read.result);
              if (
                previous.operationId !== valid.operationId ||
                JSON.stringify(previous.candidate) !== JSON.stringify(valid.candidate)
              ) {
                reject(new Error('Capture identity already belongs to different evidence'));
                return;
              }
              resolve(previous);
              return;
            }
            records.add(valid);
            jobs.put({ captureId: valid.id, attempts: 0, nextAttemptAt: 0 });
            resolve(valid);
          } catch (error) {
            reject(error);
          }
        };
      });
    },
    async get(id) {
      const db = await open();
      const value = await result(db.transaction('captures').objectStore('captures').get(id));
      return value === undefined ? undefined : captureRecordSchema.parse(value);
    },
    async list() {
      const db = await open();
      const records = await result(db.transaction('captures').objectStore('captures').getAll());
      // Unknown future schemas remain untouched in storage, never silently downgraded.
      return records.flatMap((record: unknown) => {
        const parsed = captureRecordSchema.safeParse(record);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async exportRecords() {
      const db = await open();
      const records: unknown[] = await result(
        db.transaction('captures').objectStore('captures').getAll(),
      );
      return JSON.parse(
        JSON.stringify(records, (_key, value: unknown) => {
          if (value instanceof Uint8Array) {
            let binary = '';
            for (let i = 0; i < value.length; i += 16384)
              binary += String.fromCharCode(...value.subarray(i, i + 16384));
            return { $type: 'Uint8Array', base64: btoa(binary) };
          }
          return value;
        }),
      ) as unknown[];
    },
    async update(id, change, queue = true) {
      return mutate<CaptureRecord>((records, jobs, resolve, reject) => {
        const read = records.get(id);
        read.onsuccess = () => {
          try {
            if (!read.result) throw new Error('Capture no longer exists');
            const old = captureRecordSchema.parse(read.result);
            const updated = captureRecordSchema.parse(change(old));
            if (updated.id !== old.id || updated.operationId !== old.operationId)
              throw new Error('Capture identity is immutable');
            records.put(updated);
            if (queue) jobs.put({ captureId: id, attempts: 0, nextAttemptAt: 0 });
            resolve(updated);
          } catch (e) {
            reject(e);
          }
        };
      });
    },
    async pending() {
      const db = await open();
      const jobs: unknown[] = await result(
        db.transaction('operations').objectStore('operations').getAll(),
      );
      return jobs.flatMap((job) => {
        const parsed = pendingOperationSchema.safeParse(job);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async settle(id, revision, saveResult: VaultSaveResult) {
      return mutate<CaptureRecord>((records, jobs, resolve, reject) => {
        const read = records.get(id);
        read.onsuccess = () => {
          try {
            if (!read.result) throw new Error('Capture no longer exists');
            const current = captureRecordSchema.parse(read.result);
            if (current.lifecycleRevision !== revision) {
              resolve(current);
              return;
            }
            current.persistence = saveResult.status;
            current.updatedAt = new Date().toISOString();
            if (saveResult.message) current.lastError = saveResult.message;
            else delete current.lastError;
            if (saveResult.vault) current.vault = saveResult.vault;
            if (saveResult.metadataEtag && current.vault)
              current.vault.metadataEtag = saveResult.metadataEtag;
            records.put(current);
            if (saveResult.status === 'saved-vault' || saveResult.status === 'conflict')
              jobs.delete(id);
            else {
              const pending = jobs.get(id);
              pending.onsuccess = () => {
                const attempts =
                  ((pending.result as PendingOperation | undefined)?.attempts ?? 0) + 1;
                jobs.put({
                  captureId: id,
                  attempts,
                  nextAttemptAt:
                    attempts >= 6
                      ? Number.MAX_SAFE_INTEGER
                      : Date.now() + Math.min(300000, 2000 * 2 ** attempts),
                });
              };
            }
            resolve(current);
          } catch (e) {
            reject(e);
          }
        };
      });
    },
    async import(records, accept = () => true) {
      return mutate<number>((store, _jobs, resolve, reject) => {
        let count = 0;
        let remaining = records.length;
        if (!remaining) {
          resolve(0);
          return;
        }
        for (const raw of records) {
          const parsed = captureRecordSchema.safeParse(raw);
          if (!parsed.success) {
            reject(new Error('Invalid imported record'));
            return;
          }
          const read = store.get(parsed.data.id);
          read.onsuccess = () => {
            if (!read.result && accept()) {
              store.add(parsed.data);
              count++;
            }
            if (--remaining === 0) resolve(count);
          };
        }
      });
    },
    async close() {
      (await open()).close();
      opening = undefined;
    },
  };
}
