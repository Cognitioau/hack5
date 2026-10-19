import { describe, expect, it } from 'vitest';
import { parseImportedTranscript } from '../../src/features/youtube/import';

describe('explicitly timed transcript import', () => {
  it('reads WebVTT cue identifiers, timestamps, durations and declared language', () => {
    const transcript = parseImportedTranscript(
      'WEBVTT\nLanguage: en\n\ncue-one\n00:01.250 --> 00:03.500 align:start\nAn octopus changes colour.\n\nNOTE This is metadata, not a caption.\n\n00:05.000 --> 00:06.000\nIt blends into the reef.',
    );
    expect(transcript).toEqual({
      status: 'partial',
      provenance: 'import',
      language: 'en',
      cues: [
        { start: 1.25, duration: 2.25, text: 'An octopus changes colour.' },
        { start: 5, duration: 1, text: 'It blends into the reef.' },
      ],
    });
  });

  it('reads numbered SRT captions with comma milliseconds and multiline text', () => {
    const transcript = parseImportedTranscript(
      '\uFEFF1\r\n00:01:02,003 --> 00:01:05,006\r\nFirst caption line\r\nsecond caption line.\r\n\r\n2\r\n00:02:00,000 --> 00:02:02,000\r\nNext cue.',
    );
    expect(transcript.cues[0]).toMatchObject({
      start: 62.003,
      text: 'First caption line second caption line.',
    });
    expect(transcript.cues[0]?.duration).toBeCloseTo(3.003, 6);
    expect(transcript.cues[1]?.start).toBe(120);
  });

  it('keeps printed timestamps without inventing durations for plain timestamped lines', () => {
    expect(parseImportedTranscript('[1:03] First cue.\n2:15 Second cue.').cues).toEqual([
      { start: 63, text: 'First cue.' },
      { start: 135, text: 'Second cue.' },
    ]);
  });

  it.each([
    'An interesting video without timed text.',
    '[0:10] One timed line.\nThis line has no timestamp.',
    'WEBVTT\n\n00:00:99.000 --> 00:01:00.000\nInvalid seconds.',
    '1\n00:00:10,000 --> 00:00:09,000\nThe clock runs backward.',
    'WEBVTT\n00:01.000 --> 00:02.000\nNo required header separator.',
    '[0:12] ',
    '[999:59:59] Beyond the supported capture range.',
  ])('rejects missing or malformed timing without a fabricated result: %s', (text) => {
    expect(() => parseImportedTranscript(text)).toThrow();
  });

  it('keeps hostile caption strings inert and marks the imported provenance', () => {
    const transcript = parseImportedTranscript(
      '[0:01] <script>steal()</script> is quoted evidence.',
    );
    expect(transcript.provenance).toBe('import');
    expect(transcript.cues[0]?.text).toContain('<script>');
  });

  it('bounds input and retained evidence while preserving cue identity', () => {
    expect(() => parseImportedTranscript('x'.repeat(200_001))).toThrow('200,000');
    const text = Array.from(
      { length: 100 },
      (_, index) => `[${index}:00] ${'x'.repeat(1_000)}`,
    ).join('\n');
    const transcript = parseImportedTranscript(text);
    expect(transcript.status).toBe('partial');
    expect(transcript.cues.reduce((sum, cue) => sum + cue.text.length, 0)).toBeLessThanOrEqual(
      24_000,
    );
    expect(transcript.cues[0]?.start).toBe(0);
  });
});
