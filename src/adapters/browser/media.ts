import type { CaptureCandidate, CaptureRecord } from '../../core/contracts';
import { publicMediaUrl } from '../../core/domain/security';
import { originPattern } from './settings';

const MAX_BYTES = 10 * 1024 * 1024;
export async function downloadImage(
  raw: string,
  signal: AbortSignal,
): Promise<CaptureRecord['asset']> {
  const url = publicMediaUrl(raw);
  if (!(await chrome.permissions.contains({ origins: [originPattern(url.href)] })))
    throw new Error('Media origin access has not been granted');
  const response = await fetch(url.href, {
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES)
    throw new Error('Image response unavailable or too large');
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const extensions: Record<string, 'png' | 'jpg' | 'webp' | 'gif' | 'avif'> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  const extension = extensions[mimeType];
  if (!extension) throw new Error('Image format is not a supported raster');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty image response');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Image exceeds size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    if (bitmap.width * bitmap.height > 32000000 || !bitmap.width || !bitmap.height)
      throw new Error('Image dimensions exceed safety limit');
  } finally {
    bitmap.close();
  }
  return { bytes, mimeType, extension };
}
export async function cropSnapshot(
  tabId: number,
  documentId: string,
  pageUrl: string,
  rect: NonNullable<CaptureCandidate['image']>['rect'],
  signal: AbortSignal,
): Promise<CaptureRecord['asset']> {
  async function check() {
    if (signal.aborted) throw new Error('Capture cancelled');
    const tab = await chrome.tabs.get(tabId);
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (
      !tab.active ||
      active?.id !== tabId ||
      tab.url !== pageUrl ||
      tab.windowId !== active.windowId
    )
      throw new Error('Capture target changed');
    const ack = await chrome.tabs.sendMessage(
      tabId,
      { v: 1, type: 'HIDE_OVERLAY' },
      { documentId },
    );
    if (!ack?.ok) throw new Error('Target document unavailable');
    return tab;
  }
  try {
    const tab = await check();
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    await check();
    const bitmap = await createImageBitmap(await (await fetch(data)).blob());
    try {
      const scaleX = bitmap.width / rect.viewportWidth,
        scaleY = bitmap.height / rect.viewportHeight;
      const x = Math.max(0, Math.floor(rect.x * scaleX)),
        y = Math.max(0, Math.floor(rect.y * scaleY));
      const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * scaleX)),
        bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.height) * scaleY));
      if (right <= x || bottom <= y || (right - x) * (bottom - y) > 16000000)
        throw new Error('Target is outside the viewport or too large');
      if (
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.width > rect.viewportWidth ||
        rect.y + rect.height > rect.viewportHeight
      )
        throw new Error('Image is only partly visible; move it fully into view to capture a crop');
      const canvas = new OffscreenCanvas(right - x, bottom - y);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Crop rendering unavailable');
      context.drawImage(bitmap, x, y, right - x, bottom - y, 0, 0, right - x, bottom - y);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size > MAX_BYTES || signal.aborted) throw new Error('Crop too large or cancelled');
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: 'image/png',
        extension: 'png',
      };
    } finally {
      bitmap.close();
    }
  } finally {
    await chrome.tabs
      .sendMessage(tabId, { v: 1, type: 'RESTORE_OVERLAY' }, { documentId })
      .catch(() => undefined);
  }
}
