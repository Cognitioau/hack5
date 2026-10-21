import type { CaptureRecord, PublicCapture, SearchResult } from '../contracts';

export function publicCapture(record: CaptureRecord): PublicCapture {
  const { asset: _asset, vectors: _vectors, ...safe } = record;
  return safe;
}
export async function contentHash(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function searchableChunks(record: CaptureRecord): { text: string; sourceUrl: string }[] {
  const candidate = record.candidate;
  const source = [candidate.title, candidate.text, candidate.image?.alt].filter(Boolean).join('\n');
  const chunks: { text: string; sourceUrl: string }[] = [];
  for (let start = 0; start < source.length && chunks.length < 30; start += 1400)
    chunks.push({ text: source.slice(start, start + 1600), sourceUrl: candidate.url });
  const cues = candidate.video?.transcript.cues ?? [];
  for (let start = 0; start < cues.length && chunks.length < 40; ) {
    const first = cues[start];
    if (!first) break;
    let text = '';
    let next = start;
    while (next < cues.length && text.length < 1300) {
      text += `${cues[next]?.text ?? ''} `;
      next++;
    }
    const url = new URL(candidate.url);
    url.searchParams.set('t', `${Math.floor(first.start)}s`);
    chunks.push({ text: text.slice(0, 1600), sourceUrl: url.href });
    start = next;
  }
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}
export function keywordScore(query: string, text: string): number {
  const words = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  if (!words.length) return 0;
  const lower = text.toLocaleLowerCase();
  return words.filter((word) => lower.includes(word)).length / words.length;
}
/**
 * How close in meaning a saved note must be to come back as a ghost. On real pages related
 * notes scored 0.51–0.54 and the best unrelated one 0.17, so this sits between them.
 */
export const GHOST_MIN_SCORE = 0.3;
/**
 * Whether a search result is related enough to haunt a page. A keyword match never is: a long
 * note holds most common words, so it can outscore the related one.
 */
export function haunts(result: SearchResult): boolean {
  return result.mode === 'semantic' && result.score >= GHOST_MIN_SCORE;
}
