import type { CaptureCandidate, TranscriptCue, TranscriptResult } from '../../core/contracts/index';

export { parseImportedTranscript } from './import';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer, ytd-transcript-segment-view-model';
const MAX_TRANSCRIPT_CHARACTERS = 24_000;
const trim = (text: string, maximum: number): string =>
  text.replace(/\s+/gu, ' ').trim().slice(0, maximum);

export function youtubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get('v') ?? '';
    return parsed.protocol === 'https:' &&
      ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(parsed.hostname) &&
      parsed.pathname === '/watch' &&
      VIDEO_ID.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

/** Parse only printed native cue times. A missing timestamp remains missing. */
export function parseCueTimestamp(text: string): number | null {
  const normalized = text.trim().replace(/[\u200e\u200f\u202a-\u202e]/gu, '');
  if (!/^\d{1,3}:\d{2}(?::\d{2})?$/u.test(normalized)) return null;
  const values = normalized.split(':').map(Number);
  const seconds = values.at(-1) ?? 0;
  const minutes = values.at(-2) ?? 0;
  if (seconds > 59 || (values.length === 3 && minutes > 59)) return null;
  const result =
    values.length === 3
      ? (values[0] ?? 0) * 3_600 + minutes * 60 + seconds
      : minutes * 60 + seconds;
  return result <= 604_800 ? result : null;
}

function visible(element: Element, document: Document): boolean {
  if (element.closest('[hidden],[aria-hidden="true"]')) return false;
  const panel = element.closest(PANEL_SELECTOR);
  const state = panel?.getAttribute('visibility');
  if (state && state !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') return false;
  const style = document.defaultView?.getComputedStyle(element);
  return (
    style?.display !== 'none' &&
    style?.visibility !== 'hidden' &&
    element.getBoundingClientRect().height > 0
  );
}

/**
 * Read viewer-visible native DOM only. YouTube virtualizes/loads segments, so
 * even a large successful read is partial unless completeness can be proven.
 * No private endpoints, caption downloads, authentication or remote service.
 */
export function readYouTubeTranscript(document: Document, expectedId: string): TranscriptResult {
  const empty = (status: TranscriptResult['status']): TranscriptResult => ({
    status,
    cues: [],
    provenance: 'youtube-panel',
  });
  if (youtubeVideoId(document.location.href) !== expectedId) return empty('failed');
  const panel = document.querySelector(PANEL_SELECTOR);
  if (!panel || !visible(panel, document)) return empty('unavailable');
  const segments = Array.from(panel.querySelectorAll(SEGMENT_SELECTOR)).slice(0, 2_000);
  const cues: TranscriptCue[] = [];
  const duplicateKeys = new Set<string>();
  let characterCount = 0;
  let invalidCount = 0;
  for (const segment of segments) {
    // Off-scroll DOM segments in the open transcript are still actual native
    // text; a CSS-hidden track/renderer is not a viewer-visible source.
    if (segment.closest('[hidden],[aria-hidden="true"]')) continue;
    const timeText =
      segment.querySelector('.segment-timestamp, .segment-start-offset')?.textContent ?? '';
    const body = segment.querySelector('.segment-text, .segment-text-container')?.textContent ?? '';
    const start = parseCueTimestamp(timeText);
    const text = trim(body, 2_000);
    if (start === null || text.length === 0) {
      invalidCount += 1;
      continue;
    }
    const identity = `${start}\u0000${text}`;
    if (duplicateKeys.has(identity)) continue;
    if (characterCount + text.length > MAX_TRANSCRIPT_CHARACTERS) break;
    duplicateKeys.add(identity);
    cues.push({ start, text });
    characterCount += text.length;
  }
  if (youtubeVideoId(document.location.href) !== expectedId) return empty('failed');
  if (cues.length === 0) return empty(invalidCount > 0 ? 'failed' : 'unavailable');
  cues.sort((left, right) => left.start - right.start);
  const language = trim(
    panel.querySelector('#label.ytd-menu-renderer, [data-transcript-language]')?.textContent ?? '',
    80,
  );
  return {
    status: 'partial',
    cues,
    ...(language ? { language } : {}),
    provenance: 'youtube-panel',
  };
}

export function nearbyCues(cues: readonly TranscriptCue[], seconds: number): TranscriptCue[] {
  return cues.filter((cue) => cue.start >= Math.max(0, seconds - 30) && cue.start <= seconds + 60);
}

export function currentVideoSeconds(document: Document, expectedId: string): number | null {
  if (youtubeVideoId(document.location.href) !== expectedId) return null;
  const player = document.querySelector('#movie_player');
  // A pre-roll/mid-roll uses the same video element but its clock belongs to
  // the advertisement, not the canonical watch video. Never attach that time.
  if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'))
    return null;
  const video = document.querySelector<HTMLVideoElement>(
    'video.html5-main-video, #movie_player video',
  );
  const seconds = video?.currentTime;
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 && seconds <= 604_800
    ? seconds
    : null;
}

export function extractYouTubeCandidate(
  document: Document,
  target: Element,
): CaptureCandidate | null {
  const id = youtubeVideoId(document.location.href);
  if (
    !id ||
    !target.closest(
      '#movie_player, ytd-player, #player, ytd-watch-metadata h1, #title h1, ytd-transcript-segment-renderer, ytd-transcript-segment-view-model',
    )
  )
    return null;
  const seconds = currentVideoSeconds(document, id);
  if (seconds === null) return null;
  const title =
    trim(
      document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1')
        ?.textContent ?? document.title.replace(/ - YouTube$/u, ''),
      300,
    ) || 'YouTube moment';
  const transcript = readYouTubeTranscript(document, id);
  const excerpt = nearbyCues(transcript.cues, seconds)
    .map((cue) => cue.text)
    .join(' ');
  return {
    kind: 'youtube',
    title,
    url: `https://www.youtube.com/watch?v=${id}&t=${Math.floor(seconds)}s`,
    text: trim(excerpt || title, 12_000),
    video: { id, seconds, transcript },
  };
}
