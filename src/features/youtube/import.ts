import type { TranscriptCue, TranscriptResult } from '../../core/contracts/index';

const MAX_INPUT = 200_000;
const MAX_CUE_TEXT = 24_000;

/** Imported times must be explicit; never turn an untimed paragraph into cues. */
function importedTime(value: string): number | null {
  if (!/^(?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{3})?$/u.test(value)) return null;
  const parts = value.replace(',', '.').split(':').map(Number);
  const seconds = parts.at(-1) ?? 0;
  const minutes = parts.at(-2) ?? 0;
  if (seconds >= 60 || (parts.length === 3 && minutes >= 60)) return null;
  const result = seconds + minutes * 60 + (parts.length === 3 ? (parts[0] ?? 0) * 3_600 : 0);
  return result >= 0 && result <= 604_800 ? result : null;
}

/** Strict local parser for user-imported WebVTT, SRT or timestamped lines. */
export function parseImportedTranscript(input: string): TranscriptResult {
  if (input.length > MAX_INPUT)
    throw new Error('Transcript import is limited to 200,000 characters.');
  const text = input
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (!text) throw new Error('Paste a transcript with explicit cue timestamps.');
  const parsed: TranscriptCue[] = [];
  let language: string | undefined;
  const append = (start: number | null, body: string, end?: number | null): void => {
    const cueText = body.replace(/\s+/gu, ' ').trim();
    if (
      start === null ||
      !cueText ||
      (end !== undefined && (end === null || end <= start || end - start > 86_400))
    ) {
      throw new Error('Every imported cue needs valid timestamps and nonempty text.');
    }
    parsed.push({
      start,
      ...(end === undefined || end === null ? {} : { duration: end - start }),
      text: cueText.slice(0, 2_000),
    });
  };

  if (text.includes('-->') || /^WEBVTT(?:\s|$)/u.test(text)) {
    const blocks = text.split(/\n[\t ]*\n/gu);
    for (const [index, block] of blocks.entries()) {
      const lines = block.split('\n').map((line) => line.trim());
      if (index === 0 && /^WEBVTT(?:\s|$)/u.test(lines[0] ?? '')) {
        const declared = lines.find((line) => /^Language:\s*/iu.test(line));
        if (declared) language = declared.replace(/^Language:\s*/iu, '').slice(0, 80);
        if (lines.some((line) => line.includes('-->')))
          throw new Error('WebVTT needs a blank line between its header and first cue.');
        continue;
      }
      if (/^NOTE(?:\s|$)/u.test(lines[0] ?? '') || ['STYLE', 'REGION'].includes(lines[0] ?? ''))
        continue;
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0 || timingIndex > 1)
        throw new Error('An imported caption block is missing its explicit start and end times.');
      const timing = /^(\S+)\s+-->\s+(\S+)(?:\s+(.+))?$/u.exec(lines[timingIndex] ?? '');
      if (!timing) throw new Error('An imported caption timing line is malformed.');
      const settings = timing[3];
      if (
        settings &&
        !settings
          .split(/\s+/u)
          .every((setting) => /^(?:vertical|line|position|size|align|region):\S+$/u.test(setting))
      ) {
        throw new Error('Unsupported text after a caption timestamp.');
      }
      if (lines.slice(timingIndex + 1).some((line) => line.includes('-->')))
        throw new Error('Separate caption blocks with a blank line.');
      append(
        importedTime(timing[1] ?? ''),
        lines.slice(timingIndex + 1).join(' '),
        importedTime(timing[2] ?? ''),
      );
    }
  } else {
    for (const line of text.split('\n').filter((entry) => entry.trim())) {
      const match = /^\s*(?:\[([^\]]+)\]|(\d[\d:.,]*))\s+(.+)$/u.exec(line);
      if (!match)
        throw new Error(
          'Untimed text cannot be imported as timestamped evidence. Use WebVTT, SRT or one timestamp per line.',
        );
      append(importedTime(match[1] ?? match[2] ?? ''), match[3] ?? '');
    }
  }
  if (parsed.length === 0) throw new Error('No timed caption cues were found in this import.');
  parsed.sort((left, right) => left.start - right.start);
  const cues: TranscriptCue[] = [];
  const seen = new Set<string>();
  let retained = 0;
  for (const cue of parsed) {
    const identity = `${cue.start}\u0000${cue.text}`;
    if (seen.has(identity)) continue;
    if (cues.length >= 2_000 || retained + cue.text.length > MAX_CUE_TEXT) break;
    seen.add(identity);
    cues.push(cue);
    retained += cue.text.length;
  }
  return { status: 'partial', provenance: 'import', cues, ...(language ? { language } : {}) };
}
