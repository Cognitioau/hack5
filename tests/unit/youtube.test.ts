// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=abcdefghijk"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureRecord } from '../../src/core/contracts/index';
import { searchableChunks } from '../../src/core/domain/retrieval';
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

  it('reads the transcript panel YouTube shows today, with or without a panel id', () => {
    // As served on 21 October 2026: each cue a transcript-segment-view-model whose
    // printed time is hidden from screen readers in favour of a spoken label.
    const modern = (time: string, spoken: string, text: string): string =>
      `<macro-markers-panel-item-view-model role="button"><timeline-item-view-model><div class="ytwTimelineItemViewModelContentItems"><transcript-segment-view-model class="ytwTranscriptSegmentViewModelHost"><div aria-hidden="true" class="ytwTranscriptSegmentViewModelTimestamp">${time}</div><div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">${spoken}</div><span class="ytAttributedStringHost ytAttributedStringLinkInheritColor" role="text">${text}</span></transcript-segment-view-model></div></timeline-item-view-model></macro-markers-panel-item-view-model>`;
    const cues =
      '<timeline-chapter-view-model><h3 class="ytwTimelineChapterViewModelTitle">Chapter 1: Intro</h3></timeline-chapter-view-model>' +
      modern('0:18', '18 seconds', 'We are no strangers to love.') +
      modern('1:02:03', '1 hour, 2 minutes, 3 seconds', 'You know the rules.');
    const stale = segment('0:05', 'A closed panel from earlier.');
    for (const id of ['target-id="PAmodern_transcript_view"', '']) {
      document.body.innerHTML = `<div id="movie_player"><video class="html5-main-video"></video></div><ytd-engagement-panel-section-list-renderer target-id="engagement-panel-structured-description" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"><p>An open description, holding no cues.</p></ytd-engagement-panel-section-list-renderer><ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">${stale}</ytd-engagement-panel-section-list-renderer><ytd-engagement-panel-section-list-renderer ${id} visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">${cues}</ytd-engagement-panel-section-list-renderer>`;
      expect(readYouTubeTranscript(document, 'abcdefghijk'), id).toMatchObject({
        status: 'partial',
        cues: [
          { start: 18, text: 'We are no strangers to love.' },
          { start: 3723, text: 'You know the rules.' },
        ],
      });
      const video = document.querySelector('video') as HTMLVideoElement;
      video.currentTime = 20;
      const pointed = document.querySelector('transcript-segment-view-model') as Element;
      expect(extractYouTubeCandidate(document, pointed)?.text).toBe('We are no strangers to love.');
    }
  });

  it('links a found cue as t=<seconds>s, as the note links its moment and cues', () => {
    const record = {
      candidate: {
        kind: 'youtube',
        title: 'A synthetic public lesson',
        url: 'https://www.youtube.com/watch?v=abcdefghijk&t=45s',
        text: '',
        video: {
          id: 'abcdefghijk',
          seconds: 45,
          transcript: {
            status: 'partial',
            provenance: 'youtube-panel',
            cues: [{ start: 30.4, text: 'The octopus changes colour.' }],
          },
        },
      },
    } as CaptureRecord;
    expect(searchableChunks(record).map((chunk) => chunk.sourceUrl)).toEqual([
      'https://www.youtube.com/watch?v=abcdefghijk&t=45s',
      'https://www.youtube.com/watch?v=abcdefghijk&t=30s',
    ]);
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
