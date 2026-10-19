import { beforeEach, describe, expect, it, vi } from 'vitest';

const imageOrigin = 'https://images.example.com';
const imageUrl = `${imageOrigin}/fern.png`;
let stored: Record<string, unknown>;
let contains: ReturnType<typeof vi.fn>;
let store: ReturnType<typeof vi.fn>;
let setLocalAccess: ReturnType<typeof vi.fn>;
let setSessionAccess: ReturnType<typeof vi.fn>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixtureImage(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'content-type': 'image/png', 'content-length': '4' },
  });
}

beforeEach(() => {
  vi.resetModules();
  stored = {
    settings: { unrelated: 'Preserve existing metadata' },
    vaultKey: 'synthetic-test-key',
  };
  contains = vi.fn(async () => true);
  store = vi.fn(async (value: Record<string, unknown>) => {
    Object.assign(stored, structuredClone(value));
  });
  setLocalAccess = vi.fn(async () => undefined);
  setSessionAccess = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', {
    permissions: { contains },
    storage: {
      local: {
        setAccessLevel: setLocalAccess,
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })),
        set: store,
      },
      session: { setAccessLevel: setSessionAccess },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => fixtureImage()),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 2, height: 2, close: vi.fn() })),
  );
});

describe('explicit media-download authorization', () => {
  it('denies a broad page-access permission without a separate exact image-origin grant', async () => {
    const { mayDownloadMedia } = await import('../../src/adapters/browser/media-access');
    const { downloadImage } = await import('../../src/adapters/browser/media');
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
    await expect(downloadImage(imageUrl, new AbortController().signal)).rejects.toThrow(
      'explicitly authorized',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
  });

  it('requires explicit intent and current browser permission, leaving unrelated metadata intact', async () => {
    const { authorizeMediaOrigin, mayDownloadMedia } = await import(
      '../../src/adapters/browser/media-access'
    );
    await authorizeMediaOrigin(imageOrigin);
    expect(await mayDownloadMedia(imageUrl)).toBe(true);
    expect(await mayDownloadMedia('https://other.example.com/fern.png')).toBe(false);
    expect(setLocalAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(setSessionAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(stored).toEqual({
      settings: { unrelated: 'Preserve existing metadata' },
      vaultKey: 'synthetic-test-key',
      mediaOriginGrants: { v: 1, origins: [imageOrigin] },
    });
    contains.mockResolvedValue(false);
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
  });

  it.each([
    'http://images.example.com',
    'https://127.0.0.1',
    'https://user:secret@images.example.com',
    'https://images.example.com:8443',
    'https://images.example.com/path',
    'https://images.example.com/?query=1',
    'https://images.example.com/#anchor',
    'https://localhost.',
    'https://camera.local.',
    'https://*.example.com',
    'https://*.example.com/*',
  ])('rejects an unsafe or non-exact grant %s', async (origin) => {
    const { authorizeMediaOrigin } = await import('../../src/adapters/browser/media-access');
    expect(() => authorizeMediaOrigin(origin)).toThrow();
    expect(store).not.toHaveBeenCalled();
  });

  it('refuses to record a grant when Chrome host permission is absent', async () => {
    contains.mockResolvedValue(false);
    const { authorizeMediaOrigin } = await import('../../src/adapters/browser/media-access');
    await expect(authorizeMediaOrigin(imageOrigin)).rejects.toThrow('Chrome host access');
    expect(store).not.toHaveBeenCalled();
  });

  it('fails closed on malformed grant metadata and invalid download destinations', async () => {
    stored.mediaOriginGrants = { v: 1, origins: [imageOrigin, 'https://127.0.0.1'] };
    const { mayDownloadMedia } = await import('../../src/adapters/browser/media-access');
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
    expect(await mayDownloadMedia('https://127.0.0.1/private.png')).toBe(false);
    stored.mediaOriginGrants = { v: 2, origins: [imageOrigin] };
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
    stored.mediaOriginGrants = { v: 1, origins: Array(129).fill(imageOrigin) };
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
  });

  it('serializes competing grants and revocation without losing another origin', async () => {
    const { authorizeMediaOrigin, revokeMediaOrigin, mayDownloadMedia } = await import(
      '../../src/adapters/browser/media-access'
    );
    await Promise.all([
      authorizeMediaOrigin(imageOrigin),
      authorizeMediaOrigin('https://other.example.com'),
      revokeMediaOrigin(imageOrigin),
    ]);
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
    expect(await mayDownloadMedia('https://other.example.com/picture.png')).toBe(true);
    expect(stored.mediaOriginGrants).toEqual({ v: 1, origins: ['https://other.example.com'] });
    await authorizeMediaOrigin(imageOrigin);
    expect(await mayDownloadMedia(imageUrl)).toBe(true);
  });

  it('keeps an attempted revocation denied in memory even if its storage write fails', async () => {
    const { authorizeMediaOrigin, revokeMediaOrigin, mayDownloadMedia } = await import(
      '../../src/adapters/browser/media-access'
    );
    await authorizeMediaOrigin(imageOrigin);
    store.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(revokeMediaOrigin(imageOrigin)).rejects.toThrow('Storage unavailable');
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
  });

  it('reconciles withdrawn Chrome permission without reviving it under a later broad grant', async () => {
    const { authorizeMediaOrigin, reconcileMediaOrigins, mayDownloadMedia } = await import(
      '../../src/adapters/browser/media-access'
    );
    await authorizeMediaOrigin(imageOrigin);
    contains.mockResolvedValue(false);
    await reconcileMediaOrigins();
    expect(stored.mediaOriginGrants).toEqual({ v: 1, origins: [] });
    contains.mockResolvedValue(true);
    expect(await mayDownloadMedia(imageUrl)).toBe(false);
  });
});

describe('authorized raster-download lifecycle', () => {
  it('downloads only after the separate grant, with credentials and redirects disabled', async () => {
    const { authorizeMediaOrigin } = await import('../../src/adapters/browser/media-access');
    const { downloadImage } = await import('../../src/adapters/browser/media');
    await authorizeMediaOrigin(imageOrigin);
    const asset = await downloadImage(imageUrl, new AbortController().signal);
    expect(asset).toMatchObject({ mimeType: 'image/png', extension: 'png' });
    expect(asset?.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(fetch).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
  });

  it('rejects bytes returned after local revocation while broad Chrome access remains', async () => {
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const { authorizeMediaOrigin, revokeMediaOrigin } = await import(
      '../../src/adapters/browser/media-access'
    );
    const { downloadImage } = await import('../../src/adapters/browser/media');
    await authorizeMediaOrigin(imageOrigin);
    const download = downloadImage(imageUrl, new AbortController().signal);
    const outcome = expect(download).rejects.toThrow('revoked');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await revokeMediaOrigin(imageOrigin);
    response.resolve(fixtureImage());
    await outcome;
    expect(await contains.mock.results.at(-1)?.value).toBe(true);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('discards decoding completed after revocation and closes the decoded bitmap', async () => {
    const decoded = deferred<ImageBitmap>();
    const bitmap = { width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createImageBitmap).mockReturnValue(decoded.promise);
    const { authorizeMediaOrigin, revokeMediaOrigin } = await import(
      '../../src/adapters/browser/media-access'
    );
    const { downloadImage } = await import('../../src/adapters/browser/media');
    await authorizeMediaOrigin(imageOrigin);
    const outcome = expect(downloadImage(imageUrl, new AbortController().signal)).rejects.toThrow(
      'revoked',
    );
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalled());
    await revokeMediaOrigin(imageOrigin);
    decoded.resolve(bitmap);
    await outcome;
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('rejects aborted work even if a fetch stub returns a successful response afterward', async () => {
    const response = deferred<Response>();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const { authorizeMediaOrigin } = await import('../../src/adapters/browser/media-access');
    const { downloadImage } = await import('../../src/adapters/browser/media');
    await authorizeMediaOrigin(imageOrigin);
    const controller = new AbortController();
    const outcome = expect(downloadImage(imageUrl, controller.signal)).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    response.resolve(fixtureImage());
    await outcome;
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
