// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=abcdefghijk"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentVideoSeconds,
  extractYouTubeCandidate,
  nearbyCues,
  parseCueTimestamp,
  readYouTubeTranscript,
  youtubeVideoId,
} from '../../src/features/youtube/transcript';

function panel(segments: string, visibility = 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'): void {
  document.body.innerHTML = `<div id="movie_player"><video class="html5-main-video"></video></div><ytd-watch-metadata><h1>A synthetic public lesson</h1></ytd-watch-metadata><ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="${visibility}">${segments}</ytd-engagement-panel-section-list-renderer>`;
  const video = document.querySelector('video');
  if (video) video.currentTime = 45;
}
const segment = (time: string, text: string): string =>
  `<ytd-transcript-segment-renderer><div class="segment-timestamp">${time}</div><yt-formatted-string class="segment-text">${text}</yt-formatted-string></ytd-transcript-segment-renderer>`;

beforeEach(() => {
  history.replaceState(null, '', '/watch?v=abcdefghijk');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 300));
});

describe('native YouTube transcript evidence', () => {
  it('reads real panel cue timestamps and preserves literal untrusted text as partial evidence', () => {
    panel(
      segment('0:10', 'First cue.') +
        segment('1:05', '&lt;script&gt;Not executable&lt;/script&gt;') +
        segment('1:05', '&lt;script&gt;Not executable&lt;/script&gt;'),
    );
    const transcript = readYouTubeTranscript(document, 'abcdefghijk');
    expect(transcript.status).toBe('partial');
    expect(transcript.provenance).toBe('youtube-panel');
    expect(transcript.cues).toEqual([
      { start: 10, text: 'First cue.' },
      { start: 65, text: '<script>Not executable</script>' },
    ]);
    expect(document.querySelector('script')).toBeNull();
  });

  it('distinguishes an unavailable/closed panel from a malformed timestamp', () => {
    panel(segment('0:10', 'Hidden cue'), 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    expect(readYouTubeTranscript(document, 'abcdefghijk').status).toBe('unavailable');
    panel(segment('no timestamp', 'Untimed text is not a timed cue'));
    expect(readYouTubeTranscript(document, 'abcdefghijk')).toMatchObject({
      status: 'failed',
      cues: [],
    });
  });

  it('ignores stale transcript data after in-page navigation', () => {
    panel(segment('0:10', 'Old video transcript'));
    history.replaceState(null, '', '/watch?v=lmnopqrstuv');
    expect(readYouTubeTranscript(document, 'abcdefghijk')).toMatchObject({
      status: 'failed',
      cues: [],
    });
    expect(currentVideoSeconds(document, 'abcdefghijk')).toBeNull();
  });

  it.each(['ad-showing', 'ad-interrupting'])(
    'does not label an advertisement clock as a video moment (%s)',
    (state) => {
      panel(segment('0:10', 'Actual video captions'));
      document.querySelector('#movie_player')?.classList.add(state);
      expect(currentVideoSeconds(document, 'abcdefghijk')).toBeNull();
      const target = document.querySelector('video');
      if (!target) throw new Error('Missing video fixture');
      expect(extractYouTubeCandidate(document, target)).toBeNull();
    },
  );

  it('captures a video moment without pretending missing captions failed the moment', () => {
    panel('');
    const target = document.querySelector('video');
    if (!target) throw new Error('Video fixture missing');
    const candidate = extractYouTubeCandidate(document, target);
    expect(candidate).toMatchObject({
      kind: 'youtube',
      url: 'https://www.youtube.com/watch?v=abcdefghijk&t=45s',
      video: { id: 'abcdefghijk', seconds: 45, transcript: { status: 'unavailable' } },
    });
    expect(extractYouTubeCandidate(document, document.body)).toBeNull();
  });

  it('caps transcript text and does not infer completeness from a large DOM', () => {
    panel(
      Array.from({ length: 100 }, (_, index) =>
        segment(`1:${String(index % 60).padStart(2, '0')}`, `${index} ${'x'.repeat(1_000)}`),
      ).join(''),
    );
    const transcript = readYouTubeTranscript(document, 'abcdefghijk');
    expect(transcript.status).toBe('partial');
    expect(transcript.cues.reduce((sum, cue) => sum + cue.text.length, 0)).toBeLessThanOrEqual(
      24_000,
    );
  });

  it('retains source timestamps when choosing cues near a moment', () => {
    const cues = [0, 19, 20, 50, 110, 111].map((start) => ({ start, text: `Cue at ${start}` }));
    expect(nearbyCues(cues, 50).map((cue) => cue.start)).toEqual([20, 50, 110]);
  });
});

describe('video identity and cue timestamp parsing', () => {
  it('supports printed minute and hour times, rejecting guessed or invalid values', () => {
    expect(parseCueTimestamp(' 12:34 ')).toBe(754);
    expect(parseCueTimestamp('1:02:03')).toBe(3723);
    expect(parseCueTimestamp('1:99')).toBeNull();
    expect(parseCueTimestamp('one minute')).toBeNull();
    expect(parseCueTimestamp('-0:30')).toBeNull();
  });

  it('accepts only supported YouTube watch identities', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://youtube.com.evil.test/watch?v=abcdefghijk')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/shorts/abcdefghijk')).toBeNull();
    expect(youtubeVideoId('https://www.youtube.com/watch?v=bad')).toBeNull();
  });
});
