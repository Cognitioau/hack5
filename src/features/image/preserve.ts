import type { CaptureCandidate, CaptureRecord } from '../../core/contracts';

export interface ImagePorts {
  download: (url: string, signal: AbortSignal) => Promise<CaptureRecord['asset']>;
  snapshot: (
    rect: NonNullable<CaptureCandidate['image']>['rect'],
    signal: AbortSignal,
  ) => Promise<CaptureRecord['asset']>;
}
export async function preserveImage(
  candidate: CaptureCandidate,
  ports: ImagePorts,
  signal: AbortSignal,
): Promise<{
  asset?: CaptureRecord['asset'];
  preservation: CaptureRecord['preservation'];
  message?: string;
}> {
  if (!candidate.image || signal.aborted) return { preservation: 'link' };
  try {
    const asset = await ports.download(candidate.image.url, signal);
    if (asset) return { asset, preservation: 'file' };
  } catch {
    /* Fall through to the authorized visible crop. */
  }
  if (signal.aborted) return { preservation: 'link' };
  try {
    const asset = await ports.snapshot(candidate.image.rect, signal);
    if (asset) return { asset, preservation: 'screenshot' };
  } catch {
    /* Link remains valid when the actual image cannot be preserved. */
  }
  return {
    preservation: 'link',
    message: 'Image bytes and a safe visible crop were unavailable. Saved the source link.',
  };
}
