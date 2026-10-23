import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  captureRecordSchema,
  type CaptureRecord,
  type VaultConfig,
  type VaultImportResult,
  type VaultProbeResult,
  type VaultRepository,
  type VaultSaveResult,
} from '../../core/contracts/index';

const marker = 'hack5:zombie-hand';
const maxAssetBytes = 12 * 1024 * 1024;
const maxDocumentBytes = 8 * 1024 * 1024;
const maxImportBytes = 64 * 1024 * 1024;
const maxImportRecords = 200;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const rawCaptureSchema = captureRecordSchema.pick({
  schemaVersion: true,
  id: true,
  operationId: true,
  createdAt: true,
  candidate: true,
  preservation: true,
  contentRevision: true,
});
const assetDescriptorSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().positive().max(maxAssetBytes),
    mimeType: z.string().max(100),
    extension: z.enum(['png', 'jpg', 'webp', 'gif', 'avif', 'pdf']),
  })
  .strict();
const metadataSchema = z
  .object({
    marker: z.literal(marker),
    schemaVersion: z.literal(1),
    capture: rawCaptureSchema,
    lifecycle: z
      .object({
        status: z.enum(['active', 'archived']),
        revision: z.number().int().min(0),
        updatedAt: z.string().datetime(),
      })
      .strict(),
    evidence: z
      .object({
        noteSha256: z.string().regex(/^[0-9a-f]{64}$/),
        asset: assetDescriptorSchema.optional(),
      })
      .strict(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type VaultMetadata = z.infer<typeof metadataSchema>;
type AssetDescriptor = z.infer<typeof assetDescriptorSchema>;
type NormalizedConfig = { endpoint: string; apiKey: string; folder: string };
type Reply = { status: number; bytes: Uint8Array; etag?: string };
type PreparedCapture = { record: CaptureRecord; note: Uint8Array; metadata: VaultMetadata };
type VaultClientOptions = { fetch?: typeof globalThis.fetch; timeoutMs?: number };

class VaultFailure extends Error {
  constructor(
    readonly status: Exclude<VaultSaveResult['status'], 'saved-vault'>,
    message: string,
  ) {
    super(message);
  }
}

/** Only numeric loopback and a generated namespace may receive the vault key. */
function normalizeConfig(config: VaultConfig): NormalizedConfig {
  const match = /^(https?):\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(config.endpoint);
  const port = Number(match?.[3]);
  if (!match || port > 65535) {
    throw new VaultFailure(
      'failed',
      'Use a numeric loopback endpoint with an explicit port and no path.',
    );
  }
  if (match[1] === 'http' && !config.allowInsecureLoopback) {
    throw new VaultFailure('failed', 'Plain HTTP requires the explicit loopback HTTP setting.');
  }
  if (!/^[\x21-\x7e]{1,1000}$/.test(config.apiKey)) {
    throw new VaultFailure('failed', 'A vault API key is required.');
  }
  if (
    config.folder.length > 150 ||
    config.folder
      .split('/')
      .some(
        (segment) =>
          !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(segment) || segment.trim() !== segment,
      )
  ) {
    throw new VaultFailure(
      'failed',
      'Use a vault folder made from letters, digits, spaces, underscores or hyphens.',
    );
  }
  return {
    endpoint: config.endpoint.replace(/\/$/, ''),
    apiKey: config.apiKey,
    folder: config.folder,
  };
}

/** JSON-safe metadata with deterministic ordering; never invoke a supplied toJSON/getter. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 40) throw new VaultFailure('failed', 'Capture metadata is too deeply nested.');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return `{${Object.entries(Object.getOwnPropertyDescriptors(value))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, descriptor]) => {
        if (!('value' in descriptor))
          throw new VaultFailure('failed', 'Capture metadata must contain only JSON data.');
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
      })
      .join(',')}}`;
  }
  throw new VaultFailure('failed', 'Capture metadata must contain only JSON data.');
}

function jsonBytes(value: unknown): Uint8Array {
  const bytes = encoder.encode(`${canonicalJson(value)}\n`);
  if (bytes.byteLength > maxDocumentBytes)
    throw new VaultFailure('failed', 'Capture metadata is too large.');
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/**
 * Punctuation a backslash shows as written outside the fences, newest first: Obsidian
 * also reads `%%` as a comment it hides, `$` as maths, `==` as a highlight and `^` as a
 * block reference. Notes saved before those four joined keep the earlier set.
 */
const PUNCTUATION = [/[\\`*_[\]{}()#+\-!|~%$=^]/g, /[\\`*_[\]{}()#+\-!|~]/g] as const;
type Punctuation = (typeof PUNCTUATION)[number];

function escapeMarkdown(value: string, punctuation: Punctuation): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(punctuation, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

function quoteEvidence(value: string): string {
  const longestRun = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}text\n${value}\n${fence}`;
}

// Left out of a note's file name: controls, unpaired surrogates (which no URL can carry) and the
// invisible format characters, tag characters included, which can hide text or reorder a name.
// Explicit ranges, not \p{Cf}, so the name never moves with Chrome's Unicode version.
const invisibleInName =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  /[\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ud800-\udfff\ufeff\ufff9-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/gu;
const separatorInName = /[|:]/g;
// Characters Obsidian refuses in a name or that break a [[link]], and the code marks that the wiki
// kit's hook refuses in a page that cites the name.
const unsafeInName = /[\\/*?"<>#^[\]`~]/g;
const nameLength = 60;
// File systems cap a name at 255 bytes; 60 four-byte characters, the id and `.md` would pass it.
const nameBytes = 150;

function nameText(value: string): string {
  const clean = value
    // Line breaks and tabs are controls too: they become spaces before the rest are removed.
    .replace(/\s+/g, ' ')
    .replace(invisibleInName, '')
    .replace(separatorInName, ' - ')
    .replace(unsafeInName, ' ')
    // Two percent signs open an Obsidian comment.
    .replace(/%{2,}/g, '%')
    .replace(/\s+/g, ' ')
    // A leading dot hides a file, and a trailing dot or space is dropped on some systems.
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const characters = Array.from(clean);
  let [kept, bytes] = [0, 0];
  for (const character of characters) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (kept === nameLength || bytes > nameBytes) break;
    kept++;
  }
  if (kept === characters.length) return clean;
  // Cut by character, never inside a surrogate pair, and at a word where one is near.
  const cut = characters.slice(0, kept).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space >= cut.length / 2 ? cut.slice(0, space) : cut).replace(/[\s.]+$/, '')}…`;
}

function momentName(seconds: number): string {
  const total = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, '0');
  const [hours, minutes] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60)];
  return hours ? `${hours}h${pad(minutes)}m${pad(total % 60)}s` : `${minutes}m${pad(total % 60)}s`;
}

/**
 * A note's file name, which Obsidian shows in its file list and graph: a passage's opening words,
 * an image's alt text, a video's title and moment, or else the page title, then the start of the
 * id so names stay unique. Recovery recomputes it from saved metadata, so it must never change.
 */
export function noteName(capture: Pick<CaptureRecord, 'id' | 'candidate'>): string {
  const { candidate } = capture;
  const title = nameText(candidate.title);
  const label =
    (candidate.kind === 'text' && !candidate.wholePage ? nameText(candidate.text) : '') ||
    (candidate.kind === 'image' ? nameText(candidate.image?.alt ?? '') : '') ||
    (candidate.video && title ? `${title} at ${momentName(candidate.video.seconds)}` : '') ||
    title ||
    'Grab';
  return `${label} (${capture.id.slice(0, 8)})`;
}

/** Notes saved before readable names are named by id alone; recovery still looks there. */
function legacyNotePath(config: NormalizedConfig, id: string): string {
  return `${config.folder}/captures/${id}.md`;
}

function namedNotePath(
  config: NormalizedConfig,
  capture: Pick<CaptureRecord, 'id' | 'candidate'>,
): string {
  return `${config.folder}/captures/${noteName(capture)}.md`;
}

/** A note saved under its id keeps that name, so archiving it never writes a second note. */
function notePath(config: NormalizedConfig, record: CaptureRecord): string {
  const legacy = legacyNotePath(config, record.id);
  return record.vault?.notePath === legacy ? legacy : namedNotePath(config, record);
}

function metadataPath(config: NormalizedConfig, id: string): string {
  return `${config.folder}/metadata/${id}.json`;
}

function attachmentPath(config: NormalizedConfig, id: string, extension: string): string {
  return `${config.folder}/attachments/${id}.${extension}`;
}

function sourceLink(url: string, label = 'Open source'): string {
  // Angle brackets keep parentheses in URLs from closing the generated Markdown link.
  const encoded = new URL(url).href.replace(/[<>\s]/g, (character) =>
    encodeURIComponent(character),
  );
  return `[${label}](<${encoded}>)`;
}

function renderNote(
  config: NormalizedConfig,
  record: CaptureRecord,
  asset: AssetDescriptor | undefined,
  punctuation: Punctuation,
): Uint8Array {
  const escaped = (value: string) => escapeMarkdown(value, punctuation);
  const { byline, context, passageUrl } = record.candidate;
  const frontmatter = stringifyYaml(
    {
      zombie_hand: marker,
      schema_version: 1,
      capture_id: record.id,
      operation_id: record.operationId,
      captured_at: record.createdAt,
      title: record.candidate.title,
      source: record.candidate.url,
      kind: record.candidate.kind,
      preservation: record.preservation,
      // Version-1 notes stay byte-identical: these keys appear only when captured.
      ...(byline?.author ? { author: byline.author } : {}),
      ...(byline?.site ? { site: byline.site } : {}),
      ...(byline?.published ? { published: byline.published } : {}),
      ...(record.candidate.wholePage ? { whole_page: true } : {}),
      ...(record.candidate.truncated ? { truncated: true } : {}),
    },
    { defaultStringType: 'QUOTE_DOUBLE', doubleQuotedAsJSON: true, lineWidth: 0 },
  );
  const lines = [
    '---',
    frontmatter.trimEnd(),
    '---',
    '',
    `# ${escaped(record.candidate.title)}`,
    '',
    passageUrl
      ? `${sourceLink(record.candidate.url)} · ${sourceLink(passageUrl, 'Open passage')}`
      : sourceLink(record.candidate.url),
    '',
  ];
  const credit = [byline?.author && `By ${byline.author}`, byline?.site, byline?.published]
    .filter(Boolean)
    .join(' · ');
  if (credit) lines.push(escaped(credit), '');
  lines.push(`Preservation: ${record.preservation}.`, '');
  if (asset) {
    const path = attachmentPath(config, record.id, asset.extension);
    lines.push(asset.extension === 'pdf' ? `[[${path}|Saved PDF]]` : `![[${path}]]`, '');
  }
  if (context?.heading || context?.paragraph) {
    lines.push('## Context', '');
    if (context.heading) lines.push(`Under the heading “${escaped(context.heading)}”.`, '');
    if (context.paragraph) lines.push(quoteEvidence(context.paragraph), '');
  }
  if (record.candidate.text)
    lines.push('## Captured evidence', '', quoteEvidence(record.candidate.text), '');
  if (record.candidate.truncated) lines.push('The evidence stops short of the source.', '');
  const video = record.candidate.video;
  if (video) {
    const moment = `https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(video.seconds)}s`;
    lines.push(
      `Video moment: ${sourceLink(moment)}`,
      '',
      `Transcript: ${video.transcript.status}; source: ${video.transcript.provenance}.`,
      '',
    );
    for (const cue of video.transcript.cues) {
      const seconds = Math.floor(cue.start);
      const time = `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
      lines.push(
        `[${time}](https://www.youtube.com/watch?v=${video.id}&t=${seconds}s) ${escaped(cue.text)}`,
        '',
      );
    }
  }
  const bytes = encoder.encode(`${lines.join('\n')}\n`);
  if (bytes.byteLength > maxDocumentBytes)
    throw new VaultFailure('failed', 'Capture note is too large.');
  return bytes;
}

function validateAsset(record: CaptureRecord): void {
  const asset = record.asset;
  if (record.preservation === 'file' || record.preservation === 'screenshot') {
    if (!asset)
      throw new VaultFailure('failed', 'A file outcome requires retained attachment bytes.');
  } else if (asset) {
    throw new VaultFailure(
      'failed',
      'Attachment bytes do not match the capture preservation outcome.',
    );
  }
  if (!asset) return;
  const mimeByExtension = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    pdf: 'application/pdf',
  };
  if (
    asset.bytes.byteLength < 1 ||
    asset.bytes.byteLength > maxAssetBytes ||
    mimeByExtension[asset.extension] !== asset.mimeType
  ) {
    throw new VaultFailure(
      'failed',
      'Attachment size or MIME type does not match a supported file.',
    );
  }
  if (record.preservation === 'screenshot' && asset.extension === 'pdf') {
    throw new VaultFailure('failed', 'A screenshot must contain raster image bytes.');
  }
  const bytes = asset.bytes;
  const ascii = (start: number, end: number) =>
    Array.from(bytes.subarray(start, end), (byte) => String.fromCharCode(byte)).join('');
  const validSignature = {
    png:
      bytes.length >= 8 &&
      equalBytes(bytes.subarray(0, 8), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    jpg: bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    webp: bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP',
    gif: bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)),
    avif: bytes.length >= 16 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12)),
    pdf: bytes.length >= 5 && ascii(0, 5) === '%PDF-',
  };
  if (!validSignature[asset.extension])
    throw new VaultFailure('failed', 'Attachment bytes do not match their declared file type.');
}

async function prepare(
  config: NormalizedConfig,
  input: CaptureRecord,
  punctuation: Punctuation = PUNCTUATION[0],
): Promise<PreparedCapture> {
  const validation = captureRecordSchema.safeParse(input);
  if (!validation.success) throw new VaultFailure('failed', 'The capture record is invalid.');
  const record = validation.data;
  validateAsset(record);
  // Freeze the boundary snapshot before the first asynchronous hash or network operation.
  if (record.asset) record.asset = { ...record.asset, bytes: new Uint8Array(record.asset.bytes) };
  if (record.metadata)
    record.metadata = JSON.parse(decoder.decode(jsonBytes(record.metadata))) as Record<
      string,
      unknown
    >;
  const asset = record.asset
    ? {
        sha256: await sha256(record.asset.bytes),
        byteLength: record.asset.bytes.byteLength,
        mimeType: record.asset.mimeType,
        extension: record.asset.extension,
      }
    : undefined;
  const note = renderNote(config, record, asset, punctuation);
  const metadata: VaultMetadata = {
    marker,
    schemaVersion: 1,
    capture: rawCaptureSchema.parse({
      schemaVersion: record.schemaVersion,
      id: record.id,
      operationId: record.operationId,
      createdAt: record.createdAt,
      candidate: record.candidate,
      preservation: record.preservation,
      contentRevision: record.contentRevision,
    }),
    lifecycle: {
      status: record.lifecycle,
      revision: record.lifecycleRevision,
      updatedAt: record.updatedAt,
    },
    evidence: { noteSha256: await sha256(note), ...(asset ? { asset } : {}) },
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
  jsonBytes(metadata);
  return { record, note, metadata };
}

function resultFromError(error: unknown): VaultSaveResult {
  if (error instanceof VaultFailure) return { status: error.status, message: error.message };
  // Network exception strings may contain URLs or other private request details.
  return {
    status: 'failed',
    message: 'The vault operation failed. Check the connection and retry.',
  };
}

/**
 * Why a read got no answer, naming the endpoint. Chrome hides the network error from the page,
 * so a connection it refuses is told apart only from a timeout, a cancel, and a reply that broke
 * off. Fetch rejects a refusal with a TypeError and a cancel with its signal's reason. Over HTTPS
 * the refusal is most often the plugin's self-signed certificate, which Chrome rejects until the
 * computer trusts it; the plugin's HTTP server needs no certificate.
 */
function readFailure(
  endpoint: string,
  timeoutMs: number,
  error: unknown,
  answered: boolean,
  timedOut: boolean,
): string {
  if (timedOut && !answered)
    return `The vault at ${endpoint} did not answer within ${timeoutMs / 1000} seconds. Check Obsidian is open and responding.`;
  if (answered || !(error instanceof TypeError))
    return 'The vault could not be read. Check its connection, certificate and permission.';
  return endpoint.startsWith('https:')
    ? `Chrome could not connect to ${endpoint}. If Obsidian is open, either this computer does not trust the plugin’s certificate or this port is the plugin’s HTTP server. Choose HTTP in Settings and turn on the plugin’s non-encrypted (HTTP) server.`
    : `Chrome could not connect to ${endpoint}. Check Obsidian is open, the Local REST API plugin’s non-encrypted (HTTP) server is on, and the port is the one its HTTP address shows.`;
}

/** Scoped Local REST API client. The caller owns credential storage and permission grants. */
export function createVaultClient(
  config: VaultConfig,
  options: VaultClientOptions = {},
): VaultRepository {
  let normalized: NormalizedConfig | undefined;
  let configFailure: VaultFailure | undefined;
  try {
    normalized = normalizeConfig(config);
  } catch (error) {
    configFailure =
      error instanceof VaultFailure
        ? error
        : new VaultFailure('failed', 'Vault settings are invalid.');
  }
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(10, Math.min(options.timeoutMs ?? 8_000, 30_000));
  let verified = false;
  let pendingProbe: Promise<VaultProbeResult> | undefined;

  function settings(): NormalizedConfig {
    if (!normalized)
      throw configFailure ?? new VaultFailure('failed', 'Vault settings are invalid.');
    return normalized;
  }

  async function request(
    path: string | undefined,
    method: 'GET' | 'PUT',
    signal?: AbortSignal,
    body?: Uint8Array,
    headers: Record<string, string> = {},
    limit = maxDocumentBytes,
  ): Promise<Reply> {
    const resolved = settings();
    if (signal?.aborted)
      throw new VaultFailure('failed', 'The vault operation was cancelled before transmission.');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    let answered = false;
    try {
      const url =
        path === undefined
          ? `${resolved.endpoint}/`
          : `${resolved.endpoint}/vault/${path.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${resolved.apiKey}`,
          Accept: 'application/octet-stream',
          ...headers,
        },
        ...(body ? { body: new Uint8Array(body).buffer } : {}),
        signal: abort.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      answered = true;
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new VaultFailure(
          'failed',
          'The vault endpoint returned a redirect, which is not allowed.',
        );
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        await response.body?.cancel();
        throw new VaultFailure('failed', 'The vault response exceeded the size limit.');
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > limit) {
              await reader.cancel();
              throw new VaultFailure('failed', 'The vault response exceeded the size limit.');
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const etagHeader = response.headers.get('etag');
      // Never turn a wildcard, weak validator or header list into an update precondition.
      const etag =
        etagHeader && /^"[A-Za-z0-9._:-]{1,200}"$/.test(etagHeader) ? etagHeader : undefined;
      return { status: response.status, bytes, ...(etag ? { etag } : {}) };
    } catch (error) {
      if (error instanceof VaultFailure) throw error;
      throw new VaultFailure(
        method === 'PUT' ? 'uncertain' : 'failed',
        method === 'PUT'
          ? 'The write was not acknowledged. Its outcome will be reconciled before retrying.'
          : readFailure(resolved.endpoint, timeoutMs, error, answered, timedOut),
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  function requireSuccess(reply: Reply): void {
    if (reply.status === 401 || reply.status === 403)
      throw new VaultFailure(
        'failed',
        'Vault access was denied. Check the API key and permission.',
      );
    if (reply.status < 200 || reply.status >= 300)
      throw new VaultFailure('failed', `The vault returned HTTP ${reply.status}.`);
  }

  async function readFile(
    path: string,
    signal?: AbortSignal,
    limit = maxDocumentBytes,
  ): Promise<Reply | undefined> {
    const reply = await request(path, 'GET', signal, undefined, {}, limit);
    if (reply.status === 404) return undefined;
    requireSuccess(reply);
    return reply;
  }

  async function createFile(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<Reply> {
    let reply: Reply | undefined;
    let uncertain = false;
    try {
      reply = await request(path, 'PUT', signal, bytes, {
        'If-None-Match': '*',
        'Content-Type': contentType,
      });
      if (reply.status !== 412) requireSuccess(reply);
    } catch (error) {
      if (!(error instanceof VaultFailure) || error.status !== 'uncertain') throw error;
      uncertain = true;
    }
    // Also read after a normal acknowledgement: the raw body is the evidence, not an animation.
    let current: Reply | undefined;
    try {
      current = await readFile(path, signal, Math.max(maxDocumentBytes, bytes.byteLength));
    } catch (error) {
      if (uncertain || (reply && reply.status >= 200 && reply.status < 300)) {
        throw new VaultFailure(
          'uncertain',
          'A write may have completed, but its contents could not be verified. Retry reconciliation.',
        );
      }
      throw error;
    }
    if (!current)
      throw new VaultFailure(
        'uncertain',
        'The expected file is not visible yet. Retry reconciliation.',
      );
    if (!equalBytes(current.bytes, bytes))
      throw new VaultFailure(
        'conflict',
        'A generated vault path contains different content. No existing content was overwritten.',
      );
    return current;
  }

  function parseMetadata(reply: Reply, expected: PreparedCapture): VaultMetadata {
    let metadata: VaultMetadata;
    try {
      metadata = metadataSchema.parse(JSON.parse(decoder.decode(reply.bytes)));
    } catch {
      throw new VaultFailure(
        'conflict',
        'The existing capture metadata is invalid or belongs to an unsupported format.',
      );
    }
    if (
      canonicalJson(metadata.capture) !== canonicalJson(expected.metadata.capture) ||
      canonicalJson(metadata.evidence) !== canonicalJson(expected.metadata.evidence)
    ) {
      throw new VaultFailure(
        'conflict',
        'The existing capture metadata does not match this operation and evidence.',
      );
    }
    if (!reply.etag)
      throw new VaultFailure(
        'failed',
        'The vault did not expose the ETag needed for safe metadata updates.',
      );
    return metadata;
  }

  async function ensureMetadata(prepared: PreparedCapture, signal?: AbortSignal): Promise<string> {
    const path = metadataPath(settings(), prepared.record.id);
    let current: Reply | undefined;
    let attempted = false;
    try {
      const created = await request(path, 'PUT', signal, jsonBytes(prepared.metadata), {
        'If-None-Match': '*',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      attempted = created.status >= 200 && created.status < 300;
      if (created.status !== 412) requireSuccess(created);
    } catch (error) {
      if (!(error instanceof VaultFailure) || error.status !== 'uncertain') throw error;
      attempted = true;
    }
    try {
      current = await readFile(path, signal);
    } catch (error) {
      if (attempted)
        throw new VaultFailure(
          'uncertain',
          'Capture metadata may have been written. Retry reconciliation.',
        );
      throw error;
    }
    if (!current)
      throw new VaultFailure(
        'uncertain',
        'Capture metadata is not visible yet. Retry reconciliation.',
      );
    const remote = parseMetadata(current, prepared);
    const desired = prepared.metadata.lifecycle;
    if (
      remote.lifecycle.revision > desired.revision ||
      (remote.lifecycle.revision === desired.revision && remote.lifecycle.status !== desired.status)
    ) {
      throw new VaultFailure(
        'conflict',
        'The vault contains a different or newer lifecycle. A stale operation cannot change it.',
      );
    }
    if (remote.lifecycle.revision === desired.revision) return current.etag as string;
    if (
      prepared.record.vault?.metadataEtag &&
      prepared.record.vault.metadataEtag !== current.etag
    ) {
      throw new VaultFailure(
        'conflict',
        'Capture metadata changed since the last acknowledgement. Reconcile it before updating.',
      );
    }
    const replacement = { ...remote, lifecycle: desired };
    let uncertain = false;
    try {
      const updated = await request(path, 'PUT', signal, jsonBytes(replacement), {
        'If-Match': current.etag as string,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      if (updated.status === 412)
        throw new VaultFailure(
          'conflict',
          'Capture metadata changed during the update. Nothing was overwritten.',
        );
      requireSuccess(updated);
    } catch (error) {
      if (!(error instanceof VaultFailure) || error.status !== 'uncertain') throw error;
      uncertain = true;
    }
    let verifiedUpdate: Reply | undefined;
    try {
      verifiedUpdate = await readFile(path, signal);
    } catch {
      throw new VaultFailure(
        'uncertain',
        'The lifecycle write could not be verified. Retry reconciliation.',
      );
    }
    if (!verifiedUpdate)
      throw new VaultFailure(
        'uncertain',
        'The lifecycle metadata is not visible yet. Retry reconciliation.',
      );
    const updatedMetadata = parseMetadata(verifiedUpdate, prepared);
    if (canonicalJson(updatedMetadata) !== canonicalJson(replacement)) {
      if (uncertain && canonicalJson(updatedMetadata) === canonicalJson(remote)) {
        throw new VaultFailure(
          'uncertain',
          'The lifecycle write is still unacknowledged. Retry reconciliation.',
        );
      }
      throw new VaultFailure(
        'conflict',
        'The lifecycle write differs from its expected contents. Existing content was preserved.',
      );
    }
    return verifiedUpdate.etag as string;
  }

  async function runProbe(signal?: AbortSignal): Promise<VaultProbeResult> {
    try {
      const resolved = settings();
      const status = await request(undefined, 'GET', signal);
      requireSuccess(status);
      let authenticated = false;
      try {
        authenticated =
          (JSON.parse(decoder.decode(status.bytes)) as { authenticated?: unknown })
            .authenticated === true;
      } catch {
        /* A normal API status must be JSON. */
      }
      if (!authenticated)
        throw new VaultFailure('failed', 'The vault did not confirm API-key authentication.');
      const probeId = crypto.randomUUID();
      const path = `${resolved.folder}/_health/probe-${probeId}.txt`;
      const original = encoder.encode(`${marker}\n${probeId}\nconditional-write probe\n`);
      const replacement = encoder.encode(
        `${marker}\n${probeId}\nconditional-write probe complete\n`,
      );
      const created = await createFile(path, original, 'text/plain; charset=utf-8', signal);
      if (!created.etag)
        throw new VaultFailure(
          'failed',
          'The vault must expose file ETags before normal writes are enabled.',
        );
      const duplicate = await request(path, 'PUT', signal, replacement, {
        'If-None-Match': '*',
        'Content-Type': 'text/plain',
      });
      if (duplicate.status !== 412)
        throw new VaultFailure(
          'failed',
          'The vault does not enforce create-only writes. Update the Local REST API plugin.',
        );
      const stale = await request(path, 'PUT', signal, replacement, {
        'If-Match': `"missing-${probeId}"`,
        'Content-Type': 'text/plain',
      });
      if (stale.status !== 412)
        throw new VaultFailure(
          'failed',
          'The vault does not reject stale ETags. Update the Local REST API plugin.',
        );
      const unchanged = await readFile(path, signal);
      if (!unchanged || !equalBytes(unchanged.bytes, original))
        throw new VaultFailure(
          'failed',
          'The vault did not preserve content after failed preconditions.',
        );
      const changed = await request(path, 'PUT', signal, replacement, {
        'If-Match': created.etag,
        'Content-Type': 'text/plain',
      });
      requireSuccess(changed);
      const confirmed = await readFile(path, signal);
      if (!confirmed?.etag || !equalBytes(confirmed.bytes, replacement))
        throw new VaultFailure('failed', 'The vault did not confirm the conditional update.');
      const binary = new Uint8Array([0, 255, 137, 80, 13, 10, 128, 254, 1]);
      await createFile(
        `${resolved.folder}/_health/probe-${probeId}.bin`,
        binary,
        'application/octet-stream',
        signal,
      );
      verified = true;
      return {
        ok: true,
        message:
          'Vault authentication, create-only writes, ETags, conflict rejection and binary roundtrip verified. Synthetic probe files are retained under _health.',
      };
    } catch (error) {
      verified = false;
      return {
        ok: false,
        message: resultFromError(error).message ?? 'The vault capability probe failed.',
      };
    }
  }

  async function probe(signal?: AbortSignal): Promise<VaultProbeResult> {
    if (!pendingProbe)
      pendingProbe = runProbe(signal).finally(() => {
        pendingProbe = undefined;
      });
    return pendingProbe;
  }

  async function ensureCapture(
    input: CaptureRecord,
    signal?: AbortSignal,
  ): Promise<VaultSaveResult> {
    let hasRemoteEvidence = false;
    try {
      const resolved = settings();
      let prepared = await prepare(resolved, input);
      if (!verified) {
        const outcome = await probe(signal);
        if (!outcome.ok) return { status: 'failed', message: outcome.message };
      }
      if (prepared.record.asset) {
        await createFile(
          attachmentPath(resolved, prepared.record.id, prepared.record.asset.extension),
          prepared.record.asset.bytes,
          prepared.record.asset.mimeType,
          signal,
        );
        hasRemoteEvidence = true;
      }
      const note = notePath(resolved, prepared.record);
      try {
        await createFile(note, prepared.note, 'text/markdown; charset=utf-8', signal);
      } catch (error) {
        // A note saved before the newer escapes keeps its bytes, so archiving or
        // restoring it is not a conflict.
        const earlier =
          error instanceof VaultFailure && error.status === 'conflict'
            ? await prepare(resolved, input, PUNCTUATION[1])
            : undefined;
        if (!earlier || equalBytes(earlier.note, prepared.note)) throw error;
        await createFile(note, earlier.note, 'text/markdown; charset=utf-8', signal);
        prepared = earlier;
      }
      hasRemoteEvidence = true;
      const etag = await ensureMetadata(prepared, signal);
      return {
        status: 'saved-vault',
        metadataEtag: etag,
        vault: {
          notePath: note,
          metadataPath: metadataPath(resolved, prepared.record.id),
          metadataEtag: etag,
        },
      };
    } catch (error) {
      const result = resultFromError(error);
      return hasRemoteEvidence && result.status === 'failed'
        ? {
            status: 'uncertain',
            message:
              'Some capture evidence is stored, but the complete save could not be confirmed. Retry reconciliation.',
          }
        : result;
    }
  }

  async function importCaptures(signal?: AbortSignal): Promise<VaultImportResult> {
    const records: CaptureRecord[] = [];
    const unavailable: NonNullable<VaultImportResult['unavailable']> = [];
    let skipped = 0;
    try {
      const resolved = settings();
      const listing = await readFile(`${resolved.folder}/metadata/`, signal, 256 * 1024);
      if (!listing) return { records, skipped };
      const names = z
        .object({ files: z.array(z.string().max(256)).max(10_000) })
        .parse(JSON.parse(decoder.decode(listing.bytes))).files;
      const candidates = [
        ...new Set(
          names.filter((name) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(name),
          ),
        ),
      ];
      skipped =
        names.length - candidates.length + Math.max(0, candidates.length - maxImportRecords);
      let consumed = listing.bytes.byteLength;
      const deadline = Date.now() + 30_000;
      async function readForImport(
        path: string,
        limit = maxDocumentBytes,
      ): Promise<Reply | undefined> {
        const allowance = Math.min(limit, maxImportBytes - consumed);
        if (allowance <= 0 || Date.now() >= deadline)
          throw new VaultFailure('failed', 'The vault import reached its resource limit.');
        let reply: Reply;
        try {
          reply = await request(path, 'GET', signal, undefined, {}, allowance);
        } catch (error) {
          // A failed stream may already have consumed its entire allowance.
          consumed += allowance;
          throw error;
        }
        consumed += reply.bytes.byteLength;
        if (reply.status === 404) return undefined;
        requireSuccess(reply);
        return reply;
      }
      const selected = candidates.slice(0, maxImportRecords);
      for (const [index, name] of selected.entries()) {
        if (signal?.aborted || consumed >= maxImportBytes || Date.now() >= deadline) {
          skipped += selected.length - index;
          break;
        }
        try {
          const id = name.slice(0, -5);
          const metadataReply = await readForImport(metadataPath(resolved, id));
          if (!metadataReply?.etag) {
            skipped++;
            continue;
          }
          const metadata = metadataSchema.parse(JSON.parse(decoder.decode(metadataReply.bytes)));
          if (metadata.capture.id !== id) {
            skipped++;
            continue;
          }
          canonicalJson(metadata);
          // A skipped or absent listing entry is not evidence of deletion. Reconcile only a
          // directly observed inconsistency tied to validated application-owned metadata.
          const named = namedNotePath(resolved, metadata.capture);
          const legacy = legacyNotePath(resolved, id);
          let found = named;
          const observeUnavailable = (
            reason: 'missing' | 'conflict',
            message: string,
            paths = [found],
          ) => {
            for (const path of paths)
              unavailable.push({
                id,
                operationId: metadata.capture.operationId,
                contentRevision: metadata.capture.contentRevision,
                lifecycleRevision: metadata.lifecycle.revision,
                notePath: path,
                metadataPath: metadataPath(resolved, id),
                reason,
                message,
              });
            skipped++;
          };
          let note = await readForImport(named);
          if (!note) {
            found = legacy;
            note = await readForImport(legacy);
          }
          if (!note) {
            // Either name may be the one it was saved under; each observation names the path read.
            observeUnavailable(
              'missing',
              'The saved vault note is missing. The cached capture was retained for manual reconciliation.',
              [named, legacy],
            );
            continue;
          }
          if ((await sha256(note.bytes)) !== metadata.evidence.noteSha256) {
            observeUnavailable(
              'conflict',
              'The saved vault note no longer matches its capture metadata. Existing evidence was preserved.',
            );
            continue;
          }
          let asset: CaptureRecord['asset'];
          if (metadata.evidence.asset) {
            const descriptor = metadata.evidence.asset;
            if (consumed + descriptor.byteLength > maxImportBytes) {
              skipped++;
              continue;
            }
            const file = await readForImport(
              attachmentPath(resolved, id, descriptor.extension),
              descriptor.byteLength,
            );
            if (!file) {
              observeUnavailable(
                'missing',
                'A saved vault attachment is missing. The cached capture was retained for manual reconciliation.',
              );
              continue;
            }
            if (
              file.bytes.byteLength !== descriptor.byteLength ||
              (await sha256(file.bytes)) !== descriptor.sha256
            ) {
              observeUnavailable(
                'conflict',
                'A saved vault attachment no longer matches its capture metadata. Existing evidence was preserved.',
              );
              continue;
            }
            asset = {
              bytes: new Uint8Array(file.bytes),
              extension: descriptor.extension,
              mimeType: descriptor.mimeType,
            };
          }
          const recovered = captureRecordSchema.parse({
            ...metadata.capture,
            updatedAt: metadata.lifecycle.updatedAt,
            lifecycle: metadata.lifecycle.status,
            lifecycleRevision: metadata.lifecycle.revision,
            persistence: 'saved-vault',
            indexState: 'pending',
            vault: {
              notePath: found,
              metadataPath: metadataPath(resolved, id),
              metadataEtag: metadataReply.etag,
            },
            ...(asset ? { asset } : {}),
            ...(metadata.metadata ? { metadata: metadata.metadata } : {}),
          });
          validateAsset(recovered);
          // Regenerate the raw note to confirm its marker, operation, and source match the metadata,
          // in the escaping of the version that saved it.
          if (
            !PUNCTUATION.some((punctuation) =>
              equalBytes(
                renderNote(resolved, recovered, metadata.evidence.asset, punctuation),
                note.bytes,
              ),
            )
          ) {
            observeUnavailable(
              'conflict',
              'The saved vault note no longer matches its original capture format. Existing evidence was preserved.',
            );
            continue;
          }
          records.push(recovered);
        } catch {
          skipped++;
        }
      }
      return {
        records,
        skipped,
        ...(unavailable.length ? { unavailable } : {}),
        ...(skipped
          ? {
              message: `${skipped} vault entries were skipped because they were invalid, missing, changed or outside import limits.`,
            }
          : {}),
      };
    } catch (error) {
      return {
        records,
        skipped,
        ...(unavailable.length ? { unavailable } : {}),
        message: resultFromError(error).message ?? 'Vault import failed.',
      };
    }
  }

  return { ensureCapture, syncLifecycle: ensureCapture, probe, importCaptures };
}
