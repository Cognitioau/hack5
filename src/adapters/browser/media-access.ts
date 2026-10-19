import { publicMediaUrl } from '../../core/domain/security';
import { originPattern, secureStorage } from './settings';

const STORAGE_KEY = 'mediaOriginGrants';
const MAX_ORIGINS = 128;
let mutations: Promise<void> = Promise.resolve();
const deniedOrigins = new Set<string>();
const requestVersions = new Map<string, number>();

function exactOrigin(raw: string): string {
  const url = publicMediaUrl(raw);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.hostname.endsWith('.') ||
    url.hostname.includes('*')
  )
    throw new Error('Enter an exact public HTTPS image origin without a path or query');
  return url.origin;
}

async function readOrigins(): Promise<string[]> {
  await secureStorage();
  const stored: unknown = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!stored || typeof stored !== 'object') return [];
  const record = stored as { v?: unknown; origins?: unknown };
  if (record.v !== 1 || !Array.isArray(record.origins) || record.origins.length > MAX_ORIGINS)
    return [];
  try {
    return [
      ...new Set(
        record.origins.map((origin: unknown) => {
          if (typeof origin !== 'string') throw new Error('Invalid image origin grant');
          return exactOrigin(origin);
        }),
      ),
    ];
  } catch {
    // Malformed local metadata must not turn a broad page-access grant into
    // authorization to download arbitrary remote image bytes.
    return [];
  }
}

async function writeOrigins(origins: string[]): Promise<void> {
  await secureStorage();
  await chrome.storage.local.set({ [STORAGE_KEY]: { v: 1, origins } });
}

function mutate(operation: () => Promise<void>): Promise<void> {
  const result = mutations.then(operation);
  mutations = result.catch(() => undefined);
  return result;
}

function nextRequest(origin: string): number {
  const version = (requestVersions.get(origin) ?? 0) + 1;
  requestVersions.set(origin, version);
  return version;
}

/** Called only by the trusted options-message handler after its user permission request. */
export function authorizeMediaOrigin(raw: string): Promise<void> {
  const origin = exactOrigin(raw);
  const version = nextRequest(origin);
  return mutate(async () => {
    if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] })))
      throw new Error('The image origin has not been granted Chrome host access');
    const origins = await readOrigins();
    if (!origins.includes(origin)) {
      if (origins.length >= MAX_ORIGINS) throw new Error('Too many authorized image origins');
      origins.push(origin);
    }
    await writeOrigins(origins);
    if (requestVersions.get(origin) === version) deniedOrigins.delete(origin);
  });
}

/** Revoke local intent even if a broad page permission still covers this host. */
export function revokeMediaOrigin(raw: string): Promise<void> {
  const origin = exactOrigin(raw);
  nextRequest(origin);
  // Stop new requests immediately, including if persisting the revocation fails.
  deniedOrigins.add(origin);
  return mutate(async () => {
    await writeOrigins((await readOrigins()).filter((entry) => entry !== origin));
  });
}

/** Both explicit image-download intent and current browser permission are required. */
export async function mayDownloadMedia(raw: string): Promise<boolean> {
  let origin: string;
  try {
    origin = publicMediaUrl(raw).origin;
  } catch {
    return false;
  }
  if (deniedOrigins.has(origin)) return false;
  await mutations;
  if (!(await readOrigins()).includes(origin) || deniedOrigins.has(origin)) return false;
  const permitted = await chrome.permissions.contains({ origins: [originPattern(origin)] });
  return permitted && !deniedOrigins.has(origin);
}

/** Drop stale explicit grants after browser permission removal or worker startup. */
export function reconcileMediaOrigins(): Promise<void> {
  return mutate(async () => {
    const origins = await readOrigins();
    const retained = (
      await Promise.all(
        origins.map(async (origin) => {
          if (await chrome.permissions.contains({ origins: [originPattern(origin)] }))
            return origin;
          deniedOrigins.add(origin);
          return null;
        }),
      )
    ).filter((origin): origin is string => origin !== null);
    if (retained.length !== origins.length) await writeOrigins(retained);
  });
}
