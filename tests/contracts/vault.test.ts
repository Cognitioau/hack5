import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createVaultClient, noteName } from '../../src/adapters/persistence/vault';
import type { CaptureRecord, VaultConfig } from '../../src/core/contracts/index';

// This is a contract emulator, not evidence of compatibility with a live Obsidian plugin.
const fixtureKey = 'synthetic-vault-contract-key';
const folder = 'Zombie Hand';
const text = new TextEncoder();
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const version = (bytes: Uint8Array) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

type ObservedRequest = {
  path: string;
  method: string;
  headers: IncomingMessage['headers'];
  bytes: Uint8Array;
};

class VaultEmulator {
  readonly files = new Map<string, Uint8Array>();
  readonly requests: ObservedRequest[] = [];
  readonly dropBeforeWrite = new Set<string>();
  readonly dropAfterWrite = new Set<string>();
  readonly stallAfterWrite = new Set<string>();
  onWrite: ((path: string) => void) | undefined;
  readonly raceOnUpdate = new Map<string, (bytes: Uint8Array) => Uint8Array>();
  ignoreConditions = false;
  etagOverride: string | undefined;
  rootRedirect: string | undefined;
  endpoint = '';
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  config(): VaultConfig {
    return { endpoint: this.endpoint, apiKey: fixtureKey, folder, allowInsecureLoopback: true };
  }

  metadata(record: CaptureRecord): Record<string, unknown> {
    return JSON.parse(decode(this.files.get(metadataPath(record)) ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
  }

  editMetadata(record: CaptureRecord, edit: (data: Record<string, unknown>) => void): void {
    const data = this.metadata(record);
    edit(data);
    this.files.set(metadataPath(record), text.encode(JSON.stringify(data)));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const path = decodeURIComponent(new URL(request.url ?? '/', this.endpoint).pathname);
    const method = request.method ?? 'GET';
    this.requests.push({ path, method, headers: request.headers, bytes });
    if (request.headers.authorization !== `Bearer ${fixtureKey}`) {
      response.writeHead(401).end();
      return;
    }
    if (path === '/') {
      if (this.rootRedirect) response.writeHead(302, { Location: this.rootRedirect }).end();
      else
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end('{"authenticated":true}');
      return;
    }
    if (!path.startsWith('/vault/')) {
      response.writeHead(404).end();
      return;
    }
    const vaultPath = path.slice('/vault/'.length);
    if (method === 'GET') {
      if (vaultPath.endsWith('/')) {
        const files = [...this.files.keys()]
          .filter((name) => name.startsWith(vaultPath))
          .map((name) => name.slice(vaultPath.length));
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ files }));
        return;
      }
      const current = this.files.get(vaultPath);
      if (!current) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, {
          ETag: this.etagOverride ?? version(current),
          'Content-Type': 'application/octet-stream',
        })
        .end(current);
      return;
    }
    if (method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }
    if (request.headers['if-match']) {
      const race = this.raceOnUpdate.get(vaultPath);
      if (race) {
        const current = this.files.get(vaultPath);
        if (current) this.files.set(vaultPath, race(current));
        this.raceOnUpdate.delete(vaultPath);
      }
    }
    const existing = this.files.get(vaultPath);
    if (!this.ignoreConditions) {
      if (request.headers['if-none-match'] === '*' && existing) {
        response.writeHead(412).end();
        return;
      }
      if (
        request.headers['if-match'] &&
        (!existing || request.headers['if-match'] !== version(existing))
      ) {
        response.writeHead(412).end();
        return;
      }
    }
    if (this.dropBeforeWrite.delete(vaultPath)) {
      response.destroy();
      return;
    }
    this.files.set(vaultPath, bytes);
    this.onWrite?.(vaultPath);
    if (this.dropAfterWrite.delete(vaultPath)) {
      response.destroy();
      return;
    }
    if (this.stallAfterWrite.delete(vaultPath)) return;
    response.writeHead(204, { ETag: version(bytes) }).end();
  }
}

function capture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    operationId: randomUUID(),
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    candidate: {
      kind: 'text',
      title: 'Synthetic public capture',
      url: 'https://example.com/article',
      text: 'A useful observation about local-first software.',
    },
    lifecycle: 'active',
    lifecycleRevision: 0,
    contentRevision: 0,
    persistence: 'queued-local',
    preservation: 'text',
    indexState: 'pending',
    ...overrides,
  };
}

const VERSION_1_NOTE = [
  '---',
  '"zombie_hand": "hack5:zombie-hand"',
  '"schema_version": 1',
  '"capture_id": "0b6f3c1e-5a2d-4c3e-9f1a-2b7d8e9c0a11"',
  '"operation_id": "6a1d0f3e-2b4c-4d5e-8f9a-0b1c2d3e4f5a"',
  '"captured_at": "2026-10-20T00:00:00.000Z"',
  '"title": "Notes on *local-first* [software]"',
  '"source": "https://example.com/essays/(local)?page=2"',
  '"kind": "text"',
  '"preservation": "text"',
  '---',
  '',
  '# Notes on \\*local\\-first\\* \\[software\\]',
  '',
  '[Open source](<https://example.com/essays/(local)?page=2>)',
  '',
  'Preservation: text.',
  '',
  '## Captured evidence',
  '',
  '```text',
  'A useful observation about local-first software.',
  '```',
  '',
  '',
].join('\n');

function notePath(record: CaptureRecord): string {
  return `${folder}/captures/${noteName(record)}.md`;
}
function metadataPath(record: CaptureRecord): string {
  return `${folder}/metadata/${record.id}.json`;
}
function imageRecord(): CaptureRecord {
  const bytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  return capture({
    candidate: {
      kind: 'image',
      title: 'One pixel fixture',
      url: 'https://example.com/article',
      text: 'One pixel',
      image: {
        url: 'https://example.com/pixel.png',
        alt: 'One pixel',
        rect: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 800, viewportHeight: 600 },
      },
    },
    preservation: 'file',
    asset: { bytes, extension: 'png', mimeType: 'image/png' },
  });
}

describe('scoped Obsidian vault adapter (HTTP contract emulator)', () => {
  let vault: VaultEmulator;
  beforeEach(async () => {
    vault = new VaultEmulator();
    await vault.start();
  });
  afterEach(async () => {
    await vault.stop();
  });

  it('proves preconditions and binary roundtrip before creating normal capture files', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    const saved = await client.ensureCapture(record);
    expect(saved.status).toBe('saved-vault');
    expect(saved.metadataEtag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(saved.vault).toEqual({
      notePath: notePath(record),
      metadataPath: metadataPath(record),
      metadataEtag: saved.metadataEtag,
    });
    expect(vault.files.has(notePath(record))).toBe(true);
    expect(vault.files.has(metadataPath(record))).toBe(true);
    const firstCapture = vault.requests.findIndex((request) => request.path.includes('/captures/'));
    const binaryProbe = vault.requests.findIndex(
      (request) => request.path.includes('/_health/') && request.path.endsWith('.bin'),
    );
    expect(binaryProbe).toBeGreaterThan(0);
    expect(firstCapture).toBeGreaterThan(binaryProbe);
    expect(vault.requests.every((request) => request.method !== 'DELETE')).toBe(true);
    expect(
      vault.requests
        .filter((request) => request.method === 'PUT')
        .every(
          (request) =>
            request.headers['if-none-match'] === '*' ||
            typeof request.headers['if-match'] === 'string',
        ),
    ).toBe(true);
  });

  it('refuses to enable normal writes on a server that ignores preconditions', async () => {
    vault.ignoreConditions = true;
    const outcome = await createVaultClient(vault.config()).ensureCapture(capture());
    expect(outcome.status).toBe('failed');
    expect(outcome.message).toContain('create-only');
    expect([...vault.files.keys()].every((path) => path.includes('/_health/'))).toBe(true);
  });

  it.each(['*', 'W/"weak-validator"', '"first", "second"'])(
    'rejects unsafe ETag preconditions: %s',
    async (etag) => {
      vault.etagOverride = etag;
      const outcome = await createVaultClient(vault.config()).ensureCapture(capture());
      expect(outcome.status).toBe('failed');
      expect(outcome.message).toContain('ETag');
      expect(vault.requests.some((request) => request.path.includes('/captures/'))).toBe(false);
    },
  );

  it('makes repeated capture saves idempotent without overwriting existing notes', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    const first = await client.ensureCapture(record);
    const originalNote = vault.files.get(notePath(record));
    const second = await client.ensureCapture(record);
    expect(first.status).toBe('saved-vault');
    expect(second).toEqual(first);
    expect(vault.files.get(notePath(record))).toEqual(originalNote);
    expect([...vault.files.keys()].filter((path) => path.includes('/captures/'))).toHaveLength(1);
    expect(
      vault.requests.filter((request) => request.path === '/' && request.method === 'GET'),
    ).toHaveLength(1);
  });

  it('names a note after what was grabbed, then the start of its id, in characters any vault keeps', () => {
    const id = '0b6f3c1e-5a2d-4c3e-9f1a-2b7d8e9c0a11';
    const named = (candidate: Partial<CaptureRecord['candidate']>) =>
      noteName({
        id,
        candidate: {
          kind: 'text',
          title: 'Spaced repetition | Wikipedia',
          url: 'https://example.com/a',
          text: '',
          ...candidate,
        } as CaptureRecord['candidate'],
      });
    // A passage by its opening words; a whole page, link or file by its title.
    expect(named({ text: 'The testing effect shows that\n\trecall strengthens memory.' })).toBe(
      'The testing effect shows that recall strengthens memory (0b6f3c1e)',
    );
    expect(named({ text: 'The article.', wholePage: true })).toBe(
      'Spaced repetition - Wikipedia (0b6f3c1e)',
    );
    expect(named({ kind: 'link', text: 'a link' })).toBe(
      'Spaced repetition - Wikipedia (0b6f3c1e)',
    );
    // A picture by its alt text, or its page; a video moment by its title and time.
    const image = (alt: string) => ({ url: 'https://example.com/a.png', alt });
    expect(named({ kind: 'image', image: image('An octopus on coral') } as never)).toBe(
      'An octopus on coral (0b6f3c1e)',
    );
    expect(named({ kind: 'image', image: image('') } as never)).toBe(
      'Spaced repetition - Wikipedia (0b6f3c1e)',
    );
    expect(named({ kind: 'youtube', title: 'A talk', video: { seconds: 3725.9 } } as never)).toBe(
      'A talk at 1h02m05s (0b6f3c1e)',
    );
    expect(named({ kind: 'youtube', title: 'A talk', video: { seconds: 65 } } as never)).toBe(
      'A talk at 1m05s (0b6f3c1e)',
    );
    // Nothing that ends a path, hides the file, reorders the name or breaks a [[link]].
    expect(named({ kind: 'link', title: 'a/b\\c:d*e?f"g<h>i|j#k^l[m]n' })).toBe(
      'a b c - d e f g h i - j k l m n (0b6f3c1e)',
    );
    expect(named({ kind: 'link', title: '../../.obsidian/app' })).toBe('obsidian app (0b6f3c1e)');
    expect(named({ kind: 'link', title: '..cod\u202Egnp.exe\u200B\u0007' })).toBe(
      'codgnp.exe (0b6f3c1e)',
    );
    expect(named({ kind: 'link', title: 'Party \uD83D time' })).toBe('Party time (0b6f3c1e)');
    expect(named({ kind: 'link', title: 'Tag\u{E0049}\u{E0047}\u{E004E} text' })).toBe(
      'Tag text (0b6f3c1e)',
    );
    expect(named({ kind: 'link', title: 'x\u0601\u{1D173}y' })).toBe('xy (0b6f3c1e)');
    // Nothing the wiki kit's hook refuses where a page cites the name.
    expect(named({ kind: 'link', title: 'Use `==` for 100%% a%\u200B%b' })).toBe(
      'Use == for 100% a%b (0b6f3c1e)',
    );
    expect(named({ kind: 'link', title: 'Fence ~~~ then words' })).toBe(
      'Fence then words (0b6f3c1e)',
    );
    expect(named({ kind: 'link', title: '#^[]', text: ' ' })).toBe('Grab (0b6f3c1e)');
    expect(named({ text: '\u200B', title: '|' })).toBe('- (0b6f3c1e)');
    // Long names stop at a word near 60 characters, and never inside a character.
    expect(named({ text: 'word '.repeat(30) })).toBe(
      `${Array(12).fill('word').join(' ')}… (0b6f3c1e)`,
    );
    const emoji = named({ text: `${'a'.repeat(59)}😀😀😀` });
    expect(emoji).toBe(`${'a'.repeat(59)}😀… (0b6f3c1e)`);
    expect(() => encodeURIComponent(emoji)).not.toThrow();
    // Four-byte characters stop sooner, so the file name stays inside a file system's 255 bytes.
    const wide = named({ text: '😀'.repeat(50) });
    expect(wide).toBe(`${'😀'.repeat(37)}… (0b6f3c1e)`);
    expect(new TextEncoder().encode(`${wide}.md`).byteLength).toBeLessThan(255);
  });

  it('keeps and recovers a note saved under its id before notes had readable names', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    // As main at a14f85a saved it: the same bytes, named by the id alone.
    const legacy = `${folder}/captures/${record.id}.md`;
    vault.files.set(legacy, vault.files.get(notePath(record)) ?? new Uint8Array());
    vault.files.delete(notePath(record));
    const imported = await createVaultClient(vault.config()).importCaptures();
    expect(imported.unavailable).toBeUndefined();
    expect(imported.records.map((entry) => entry.vault?.notePath)).toEqual([legacy]);
    // Saving it again, as archiving and retrying do, keeps the one note it has.
    const again = await client.ensureCapture({ ...record, vault: imported.records[0]?.vault });
    expect(again).toMatchObject({ status: 'saved-vault', vault: { notePath: legacy } });
    const notes = () => [...vault.files.keys()].filter((path) => path.includes('/captures/'));
    expect(notes()).toEqual([legacy]);
    // With neither name there, both are reported, so whichever was saved is quarantined.
    vault.files.delete(legacy);
    const gone = await createVaultClient(vault.config()).importCaptures();
    expect(gone.skipped).toBe(1);
    expect(gone.unavailable?.map((entry) => [entry.notePath, entry.reason])).toEqual([
      [notePath(record), 'missing'],
      [legacy, 'missing'],
    ]);
    // A title holding an unpaired surrogate, which no URL can carry, still saves.
    const unpaired = capture({
      candidate: {
        kind: 'link',
        title: 'Party \uD83D time',
        url: 'https://example.com/a',
        text: '',
      },
    });
    expect(await client.ensureCapture(unpaired)).toMatchObject({
      status: 'saved-vault',
      vault: { notePath: `${folder}/captures/Party time (${unpaired.id.slice(0, 8)}).md` },
    });
    // A new capture, or one saved under its readable name, is written under that name.
    const fresh = capture();
    expect(await client.ensureCapture(fresh)).toMatchObject({
      vault: {
        notePath: `${folder}/captures/A useful observation about local-first software (${fresh.id.slice(0, 8)}).md`,
      },
    });
  });

  it('serializes hostile title fields and places raw source markup inside an unbreakable text fence', async () => {
    const raw =
      '```\n<img src="https://tracker.example/secret">\n![[.obsidian/plugins/evil/main.js]]\n~~~\n[run](obsidian://command?id=evil)';
    const title = '---\napi_key: forged\n<img src=x onerror=bad>\n# title';
    const record = capture({
      candidate: { kind: 'text', title, url: 'https://example.com/path?a=(b)', text: raw },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    const note = decode(vault.files.get(notePath(record)) ?? new Uint8Array());
    const frontmatter = note.split('\n---\n')[0]?.slice(4) ?? '';
    const parsed = parseYaml(frontmatter) as Record<string, unknown>;
    expect(parsed.title).toBe(title);
    expect(parsed.api_key).toBeUndefined();
    expect(parsed.capture_id).toBe(record.id);
    expect(note).toContain(`\n\`\`\`\`text\n${raw}\n\`\`\`\`\n`);
    expect(note).toContain('[Open source](<https://example.com/path?a=(b)>)');
    expect(note.split('\n---\n')[1]?.split('## Captured evidence')[0]).not.toContain('<img');
  });

  it('writes a note without the newer fields byte for byte as version 1 did', async () => {
    const record = capture({
      id: '0b6f3c1e-5a2d-4c3e-9f1a-2b7d8e9c0a11',
      operationId: '6a1d0f3e-2b4c-4d5e-8f9a-0b1c2d3e4f5a',
      candidate: {
        kind: 'text',
        title: 'Notes on *local-first* [software]',
        url: 'https://example.com/essays/(local)?page=2',
        text: 'A useful observation about local-first software.',
      },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    // Rendered by main at 78f5c0e, before the passage, credit and whole-page fields existed.
    expect(decode(vault.files.get(notePath(record)) ?? new Uint8Array())).toBe(VERSION_1_NOTE);
  });

  it('gives a passage its heading, paragraph, deep link and credit, all escaped', async () => {
    const record = capture({
      candidate: {
        kind: 'text',
        title: 'How to Do Great Work',
        url: 'https://example.com/essays/great-work',
        text: 'Curiosity is the engine.',
        passageUrl: 'https://example.com/essays/great-work#:~:text=Curiosity%20is%20the%20engine.',
        context: {
          heading: 'Why # it [[matters]]',
          paragraph: 'Before it. Curiosity is the engine. ```\n<img src=x onerror=bad>',
        },
        byline: { author: '<img src=x> [[evil]]', site: 'Example Essays', published: '2023-07-01' },
        wholePage: true,
        truncated: true,
      },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    const note = decode(vault.files.get(notePath(record)) ?? new Uint8Array());
    const [frontmatter = '', body = ''] = note.slice(4).split('\n---\n');
    expect(parseYaml(frontmatter)).toMatchObject({
      author: '<img src=x> [[evil]]',
      site: 'Example Essays',
      published: '2023-07-01',
      whole_page: true,
      truncated: true,
    });
    expect(body).toContain(
      '[Open source](<https://example.com/essays/great-work>) · [Open passage](<https://example.com/essays/great-work#:~:text=Curiosity%20is%20the%20engine.>)',
    );
    expect(body).toContain(
      'By &lt;img src\\=x&gt; \\[\\[evil\\]\\] · Example Essays · 2023\\-07\\-01',
    );
    expect(body).toContain('## Context\n\nUnder the heading “Why \\# it \\[\\[matters\\]\\]”.');
    expect(body).toContain(
      '\n````text\nBefore it. Curiosity is the engine. ```\n<img src=x onerror=bad>\n````\n',
    );
    expect(body).toContain('The evidence stops short of the source.');
    // Outside the fences nothing the page wrote can become markup or a link.
    const unfenced = body.replace(/\n````text\n[\s\S]*?\n````\n/gu, '\n');
    expect(unfenced).not.toContain('<img');
    expect(unfenced).not.toContain('[[');
  });

  it('escapes the comment, maths, highlight and block marks Obsidian reads outside the fences', async () => {
    const record = capture({
      candidate: {
        kind: 'text',
        title: 'Notes %% hidden from view %% at 50% for $5 == ^cite',
        url: 'https://example.com/a',
        text: 'Words.',
        context: { heading: 'Cost $$x$$ and %%' },
        byline: { author: 'A ==highlight==', site: 'Site ^block' },
      },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    const body = decode(vault.files.get(notePath(record)) ?? new Uint8Array()).split('\n---\n')[1];
    expect(body).toContain(
      '# Notes \\%\\% hidden from view \\%\\% at 50\\% for \\$5 \\=\\= \\^cite\n',
    );
    expect(body).toContain('Under the heading “Cost \\$\\$x\\$\\$ and \\%\\%”.');
    expect(body).toContain('By A \\=\\=highlight\\=\\= · Site \\^block\n');
    expect(body?.replace(/\n```text\n[\s\S]*?\n```\n/gu, '\n')).not.toMatch(/(?<!\\)[%$=^]/u);
    const video = capture({
      candidate: {
        kind: 'youtube',
        title: 'A synthetic lesson',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        text: '',
        video: {
          id: 'abcdefghijk',
          seconds: 3,
          transcript: {
            status: 'partial',
            cues: [{ start: 3, text: 'At 50% of $5 == ^x %%' }],
            provenance: 'youtube-panel',
          },
        },
      },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(video)).status).toBe(
      'saved-vault',
    );
    expect(decode(vault.files.get(notePath(video)) ?? new Uint8Array())).toContain(
      '\n[0:03](https://www.youtube.com/watch?v=abcdefghijk&t=3s) At 50\\% of \\$5 \\=\\= \\^x \\%\\%\n',
    );
    const imported = await createVaultClient(vault.config()).importCaptures();
    expect(imported.unavailable).toBeUndefined();
    expect(imported.records.map((entry) => entry.id).sort()).toEqual([record.id, video.id].sort());
  });

  it('still reads and archives a note saved before %, $, = and ^ were escaped', async () => {
    const client = createVaultClient(vault.config());
    const record = capture({
      candidate: {
        kind: 'text',
        title: 'Save 50% = $5 ^now',
        url: 'https://example.com/a',
        text: 'Words.',
      },
    });
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    // The note and its recorded hash as main at 672ff6b wrote them.
    const current = decode(vault.files.get(notePath(record)) ?? new Uint8Array());
    const earlier = text.encode(
      current.replace('\n# Save 50\\% \\= \\$5 \\^now\n', '\n# Save 50% = $5 ^now\n'),
    );
    expect(decode(earlier)).not.toBe(current);
    vault.files.set(notePath(record), earlier);
    vault.editMetadata(record, (data) => {
      (data.evidence as { noteSha256: string }).noteSha256 = createHash('sha256')
        .update(earlier)
        .digest('hex');
    });
    const imported = await createVaultClient(vault.config()).importCaptures();
    expect(imported.unavailable).toBeUndefined();
    expect(imported.records.map((entry) => entry.id)).toEqual([record.id]);
    const archived = await client.syncLifecycle({
      ...record,
      lifecycle: 'archived',
      lifecycleRevision: 1,
      updatedAt: '2026-10-20T00:01:00.000Z',
    });
    expect(archived.status).toBe('saved-vault');
    expect(vault.metadata(record).lifecycle).toMatchObject({ status: 'archived', revision: 1 });
    expect(vault.files.get(notePath(record))).toEqual(earlier);
  });

  it('writes a dropped note again in the current escaping, never the earlier one', async () => {
    const client = createVaultClient(vault.config());
    const record = capture({
      candidate: { kind: 'text', title: 'Save 50%', url: 'https://example.com/a', text: 'Words.' },
    });
    vault.dropBeforeWrite.add(notePath(record));
    expect((await client.ensureCapture(record)).status).toBe('uncertain');
    expect(vault.files.has(notePath(record))).toBe(false);
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    expect(decode(vault.files.get(notePath(record)) ?? new Uint8Array())).toContain(
      '\n# Save 50\\%\n',
    );
  });

  it('writes no context section for an empty context', async () => {
    const record = capture({
      candidate: {
        kind: 'text',
        title: 'A passage',
        url: 'https://example.com/a',
        text: 'Words.',
        context: {},
      },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    expect(decode(vault.files.get(notePath(record)) ?? new Uint8Array())).not.toContain(
      '## Context',
    );
  });

  it('imports a passage with its context, deep link and credit intact', async () => {
    const record = capture({
      candidate: {
        kind: 'text',
        title: 'How to Do Great Work',
        url: 'https://example.com/essays/great-work',
        text: 'Curiosity is the engine.',
        passageUrl: 'https://example.com/essays/great-work#:~:text=Curiosity%20is%20the%20engine.',
        context: {
          heading: 'Choosing',
          paragraph: 'Before it. Curiosity is the engine. After it.',
        },
        byline: { author: 'Paul Example', site: 'Example Essays', published: '2023-07-01' },
        wholePage: true,
        truncated: true,
      },
    });
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    const imported = await createVaultClient(vault.config()).importCaptures();
    expect(imported.skipped).toBe(0);
    expect(imported.records.find((entry) => entry.id === record.id)?.candidate).toEqual(
      record.candidate,
    );
  });

  it('preserves image bytes and uses a generated attachment path instead of a page title', async () => {
    const record = imageRecord();
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe(
      'saved-vault',
    );
    const path = `${folder}/attachments/${record.id}.png`;
    expect(vault.files.get(path)).toEqual(record.asset?.bytes);
    expect(decode(vault.files.get(notePath(record)) ?? new Uint8Array())).toContain(`![[${path}]]`);
  });

  it('rejects HTML masquerading as an attachment before transmitting anything', async () => {
    const record = imageRecord();
    record.asset = {
      bytes: text.encode('<html>login required</html>'),
      extension: 'png',
      mimeType: 'image/png',
    };
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe('failed');
    expect(vault.requests).toHaveLength(0);
  });

  it('reconciles an unacknowledged completed note write by reading its exact bytes', async () => {
    const record = capture();
    vault.dropAfterWrite.add(notePath(record));
    const result = await createVaultClient(vault.config()).ensureCapture(record);
    expect(result.status).toBe('saved-vault');
    expect(vault.files.has(metadataPath(record))).toBe(true);
  });

  it('reconciles a real response timeout without performing an unconditional retry', async () => {
    const record = capture();
    const client = createVaultClient(vault.config(), { timeoutMs: 100 });
    expect((await client.probe()).ok).toBe(true);
    vault.stallAfterWrite.add(notePath(record));
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    const writes = vault.requests.filter(
      (request) => request.path === `/vault/${notePath(record)}` && request.method === 'PUT',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.headers['if-none-match']).toBe('*');
  });

  it('retains uncertainty when cancelled after a remote write and can reconcile directly to archived', async () => {
    const record = capture();
    const client = createVaultClient(vault.config());
    const controller = new AbortController();
    vault.onWrite = (path) => {
      if (path === notePath(record)) controller.abort();
    };
    expect((await client.ensureCapture(record, controller.signal)).status).toBe('uncertain');
    expect(vault.files.has(notePath(record))).toBe(true);
    expect(vault.files.has(metadataPath(record))).toBe(false);
    vault.onWrite = undefined;
    expect(
      (await client.syncLifecycle({ ...record, lifecycle: 'archived', lifecycleRevision: 1 }))
        .status,
    ).toBe('saved-vault');
    expect(vault.metadata(record).lifecycle).toMatchObject({ status: 'archived', revision: 1 });
  });

  it('keeps an interrupted partial file capture uncertain and safely completes it on retry', async () => {
    const client = createVaultClient(vault.config());
    const record = imageRecord();
    vault.dropBeforeWrite.add(notePath(record));
    expect((await client.ensureCapture(record)).status).toBe('uncertain');
    expect(vault.files.has(`${folder}/attachments/${record.id}.png`)).toBe(true);
    expect(vault.files.has(metadataPath(record))).toBe(false);
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    expect([...vault.files.keys()].filter((path) => path.includes('/attachments/'))).toHaveLength(
      1,
    );
  });

  it('reports an existing different note as a conflict and never overwrites it', async () => {
    const record = capture();
    const original = text.encode('A user-owned note occupying this path.');
    vault.files.set(notePath(record), original);
    expect((await createVaultClient(vault.config()).ensureCapture(record)).status).toBe('conflict');
    expect(vault.files.get(notePath(record))).toEqual(original);
    expect(vault.files.has(metadataPath(record))).toBe(false);
  });

  it('archives only metadata with a matching ETag and preserves the raw note', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    const saved = await client.ensureCapture(record);
    const raw = vault.files.get(notePath(record));
    const archived: CaptureRecord = {
      ...record,
      lifecycle: 'archived',
      lifecycleRevision: 1,
      updatedAt: '2026-10-20T00:01:00.000Z',
      vault: {
        notePath: notePath(record),
        metadataPath: metadataPath(record),
        ...(saved.metadataEtag ? { metadataEtag: saved.metadataEtag } : {}),
      },
    };
    expect((await client.syncLifecycle(archived)).status).toBe('saved-vault');
    expect(vault.metadata(record).lifecycle).toEqual({
      status: 'archived',
      revision: 1,
      updatedAt: archived.updatedAt,
    });
    expect(vault.files.get(notePath(record))).toEqual(raw);
    const writes = vault.requests.filter(
      (request) => request.path === `/vault/${metadataPath(record)}` && request.method === 'PUT',
    );
    expect(writes.some((request) => request.headers['if-match'] === saved.metadataEtag)).toBe(true);
    expect(vault.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('does not let a late active save revive an archived lifecycle', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    await client.ensureCapture(record);
    await client.syncLifecycle({
      ...record,
      lifecycle: 'archived',
      lifecycleRevision: 1,
      updatedAt: '2026-10-20T00:01:00.000Z',
    });
    expect((await client.ensureCapture(record)).status).toBe('conflict');
    expect(vault.metadata(record).lifecycle).toMatchObject({ status: 'archived', revision: 1 });
  });

  it('preserves unknown metadata fields when reconciling an archive that preceded save acknowledgement', async () => {
    const client = createVaultClient(vault.config());
    const record = capture({ metadata: { optionalModule: { a: 1 } } });
    await client.ensureCapture(record);
    vault.editMetadata(record, (data) => {
      data.futureExtension = { retained: ['yes'] };
    });
    const outcome = await client.syncLifecycle({
      ...record,
      lifecycle: 'archived',
      lifecycleRevision: 1,
      updatedAt: '2026-10-20T00:01:00.000Z',
    });
    expect(outcome.status).toBe('saved-vault');
    expect(vault.metadata(record).futureExtension).toEqual({ retained: ['yes'] });
    expect(vault.metadata(record).metadata).toEqual({ optionalModule: { a: 1 } });
  });

  it('reports changes since an acknowledged ETag as a conflict', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    const saved = await client.ensureCapture(record);
    vault.editMetadata(record, (data) => {
      data.userEdit = 'retain me';
    });
    const changed = vault.files.get(metadataPath(record));
    const outcome = await client.syncLifecycle({
      ...record,
      lifecycle: 'archived',
      lifecycleRevision: 1,
      vault: {
        notePath: notePath(record),
        metadataPath: metadataPath(record),
        ...(saved.metadataEtag ? { metadataEtag: saved.metadataEtag } : {}),
      },
    });
    expect(outcome.status).toBe('conflict');
    expect(vault.files.get(metadataPath(record))).toEqual(changed);
  });

  it('rejects a metadata mutation between the read and conditional update', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    await client.ensureCapture(record);
    vault.raceOnUpdate.set(metadataPath(record), (bytes) => {
      const data = JSON.parse(decode(bytes)) as Record<string, unknown>;
      data.concurrentEdit = 'retain me';
      return text.encode(JSON.stringify(data));
    });
    expect(
      (await client.syncLifecycle({ ...record, lifecycle: 'archived', lifecycleRevision: 1 }))
        .status,
    ).toBe('conflict');
    expect(vault.metadata(record).concurrentEdit).toBe('retain me');
    expect(vault.metadata(record).lifecycle).toMatchObject({ status: 'active', revision: 0 });
  });

  it('reconciles a dropped lifecycle acknowledgement and preserves archived status', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    await client.ensureCapture(record);
    // Existing create-only metadata attempts receive 412 before this drop is consumed.
    vault.dropAfterWrite.add(metadataPath(record));
    expect(
      (await client.syncLifecycle({ ...record, lifecycle: 'archived', lifecycleRevision: 1 }))
        .status,
    ).toBe('saved-vault');
    expect(vault.metadata(record).lifecycle).toMatchObject({ status: 'archived', revision: 1 });
  });

  it('requires matching application provenance before any lifecycle update', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    await client.ensureCapture(record);
    vault.editMetadata(record, (data) => {
      data.marker = 'some-other-app';
    });
    const before = vault.files.get(metadataPath(record));
    expect(
      (await client.syncLifecycle({ ...record, lifecycle: 'archived', lifecycleRevision: 1 }))
        .status,
    ).toBe('conflict');
    expect(vault.files.get(metadataPath(record))).toEqual(before);
  });

  it('imports verified active and archived records, while excluding edited or missing evidence', async () => {
    const client = createVaultClient(vault.config());
    const active = capture({ metadata: { absentFeature: { retained: true } } });
    const archived = imageRecord();
    archived.lifecycle = 'archived';
    archived.lifecycleRevision = 1;
    const edited = capture();
    const missing = capture();
    for (const record of [active, archived, edited, missing])
      expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    vault.files.set(notePath(edited), text.encode('User has edited this note.'));
    vault.files.delete(notePath(missing));
    const before = vault.requests.length;
    const imported = await createVaultClient(vault.config()).importCaptures();
    expect(imported.skipped).toBe(2);
    expect(imported.records.map((record) => record.id).sort()).toEqual(
      [active.id, archived.id].sort(),
    );
    expect(imported.records.find((record) => record.id === archived.id)).toMatchObject({
      lifecycle: 'archived',
      lifecycleRevision: 1,
      asset: archived.asset,
    });
    expect(imported.records.find((record) => record.id === active.id)?.metadata).toEqual(
      active.metadata,
    );
    expect(imported.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: edited.id,
          operationId: edited.operationId,
          contentRevision: 0,
          lifecycleRevision: 0,
          notePath: notePath(edited),
          metadataPath: metadataPath(edited),
          reason: 'conflict',
        }),
        expect.objectContaining({
          id: missing.id,
          operationId: missing.operationId,
          contentRevision: 0,
          lifecycleRevision: 0,
          notePath: notePath(missing),
          metadataPath: metadataPath(missing),
          reason: 'missing',
        }),
      ]),
    );
    // The missing note is reported under each name it could have been saved under.
    expect(imported.unavailable).toHaveLength(3);
    expect(vault.requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
  });

  it('reports directly observed missing and changed attachments without changing remote evidence', async () => {
    const client = createVaultClient(vault.config());
    const missing = imageRecord();
    const changed = imageRecord();
    for (const record of [missing, changed])
      expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    vault.files.delete(`${folder}/attachments/${missing.id}.png`);
    const altered = new Uint8Array(changed.asset?.bytes ?? []);
    altered[altered.length - 1] = 123;
    vault.files.set(`${folder}/attachments/${changed.id}.png`, altered);
    const before = vault.requests.length;
    const imported = await client.importCaptures();
    expect(imported.records).toEqual([]);
    expect(imported.unavailable?.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: missing.id, reason: 'missing' },
      { id: changed.id, reason: 'conflict' },
    ]);
    expect(vault.files.get(`${folder}/attachments/${changed.id}.png`)).toEqual(altered);
    expect(vault.requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
  });

  it('reports a changed raw note even when its edited metadata repeats the changed hash', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    const altered = text.encode('User-owned replacement evidence');
    vault.files.set(notePath(record), altered);
    vault.editMetadata(record, (data) => {
      (data.evidence as { noteSha256: string }).noteSha256 = createHash('sha256')
        .update(altered)
        .digest('hex');
    });
    const imported = await client.importCaptures();
    expect(imported.records).toEqual([]);
    expect(imported.unavailable).toEqual([
      expect.objectContaining({ id: record.id, reason: 'conflict' }),
    ]);
    expect(vault.files.get(notePath(record))).toEqual(altered);
  });

  it('does not infer missing records from an absent metadata entry or a failed directory scan', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    vault.files.delete(metadataPath(record));
    expect((await client.importCaptures()).unavailable).toBeUndefined();
    const failed = createVaultClient(vault.config(), {
      fetch: async () => new Response('offline', { status: 503 }),
    });
    const imported = await failed.importCaptures();
    expect(imported.records).toEqual([]);
    expect(imported.unavailable).toBeUndefined();
    expect(imported.message).toContain('503');
    expect(vault.files.has(notePath(record))).toBe(true);
  });

  it('retains positive missing observations without treating a failed record read as another deletion', async () => {
    const client = createVaultClient(vault.config());
    const missing = capture();
    const unreadable = capture();
    for (const record of [missing, unreadable])
      expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    vault.files.delete(notePath(missing));
    const importing = createVaultClient(vault.config(), {
      fetch: (input, init) => {
        if (
          decodeURIComponent(new URL(String(input)).pathname) === `/vault/${notePath(unreadable)}`
        )
          return Promise.resolve(new Response('unavailable', { status: 503 }));
        return fetch(input, init);
      },
    });
    const imported = await importing.importCaptures();
    expect(imported.records).toEqual([]);
    expect(imported.skipped).toBe(2);
    // Once under each name the note could have been saved under.
    expect(imported.unavailable?.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: missing.id, reason: 'missing' },
      { id: missing.id, reason: 'missing' },
    ]);
  });

  it('does not infer a conflict or deletion from a response that exceeds import bounds', async () => {
    const client = createVaultClient(vault.config());
    const record = capture();
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    const importing = createVaultClient(vault.config(), {
      fetch: (input, init) => {
        if (decodeURIComponent(new URL(String(input)).pathname) === `/vault/${notePath(record)}`) {
          return Promise.resolve(
            new Response('bounded', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
          );
        }
        return fetch(input, init);
      },
    });
    const imported = await importing.importCaptures();
    expect(imported.skipped).toBe(1);
    expect(imported.records).toEqual([]);
    expect(imported.unavailable).toBeUndefined();
  });

  it('does not infer a missing record from entries beyond the scan count limit', async () => {
    const record = capture();
    const client = createVaultClient(vault.config());
    expect((await client.ensureCapture(record)).status).toBe('saved-vault');
    const metadata = vault.files.get(metadataPath(record));
    vault.files.delete(metadataPath(record));
    for (let index = 0; index < 200; index++)
      vault.files.set(`${folder}/metadata/${randomUUID()}.json`, text.encode('{}'));
    if (!metadata) throw new Error('Synthetic metadata was not created');
    vault.files.set(metadataPath(record), metadata);
    vault.files.delete(notePath(record));
    const before = vault.requests.length;
    const imported = await client.importCaptures();
    expect(imported.skipped).toBe(201);
    expect(imported.unavailable).toBeUndefined();
    expect(
      vault.requests
        .slice(before)
        .some((request) => request.path === `/vault/${metadataPath(record)}`),
    ).toBe(false);
  });

  it('does not read paths provided by an invalid metadata listing or unknown record version', async () => {
    const record = capture();
    const client = createVaultClient(vault.config());
    await client.ensureCapture(record);
    vault.editMetadata(record, (data) => {
      data.schemaVersion = 999;
    });
    vault.files.set(`${folder}/metadata/../../.obsidian/secrets.json`, text.encode('{}'));
    const before = vault.requests.length;
    const imported = await client.importCaptures();
    expect(imported.records).toHaveLength(0);
    expect(imported.skipped).toBe(2);
    expect(imported.unavailable).toBeUndefined();
    expect(vault.requests.slice(before).some((request) => request.path.includes('.obsidian'))).toBe(
      false,
    );
  });

  it('fails closed on redirects and never sends the key to their destination', async () => {
    const destination = new VaultEmulator();
    await destination.start();
    try {
      vault.rootRedirect = destination.endpoint;
      const outcome = await createVaultClient(vault.config()).probe();
      expect(outcome.ok).toBe(false);
      expect(destination.requests).toHaveLength(0);
    } finally {
      await destination.stop();
    }
  });

  it('omits ambient credentials and referrers for every vault request', async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => fetch(input, init));
    expect((await createVaultClient(vault.config(), { fetch: fetcher }).probe()).ok).toBe(true);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    }
  });

  describe('when a read gets no answer, says why and names the endpoint', () => {
    /** Chrome's rejection when it will not connect, as for a certificate it does not trust. */
    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    /**
     * A request that waits until it is aborted, as one to a vault that never answers. Like
     * fetch, it rejects with the signal's reason: an AbortError unless the abort gave another.
     */
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const generic =
      'The vault could not be read. Check its connection, certificate and permission.';

    it('names an HTTPS endpoint Chrome will not connect to, the certificate, and the HTTP way round it', async () => {
      const outcome = await createVaultClient(
        { ...vault.config(), endpoint: 'https://127.0.0.1:27124', allowInsecureLoopback: false },
        { fetch: refused },
      ).probe();
      expect(outcome).toEqual({
        ok: false,
        message:
          'Chrome could not connect to https://127.0.0.1:27124. If Obsidian is open, either this computer does not trust the plugin’s certificate or this port is the plugin’s HTTP server. Choose HTTP in Settings and turn on the plugin’s non-encrypted (HTTP) server.',
      });
      // The status line beside Save shows at most 300 characters of it, from the longest endpoint.
      const longest = await createVaultClient(
        { ...vault.config(), endpoint: 'https://127.0.0.1:65535', allowInsecureLoopback: false },
        { fetch: refused },
      ).probe();
      expect(longest.message.length).toBeLessThanOrEqual(300);
    });

    it('names HTTPS sent to the plugin’s HTTP server, the mix-up a person makes, and the way out', async () => {
      // The emulator speaks plain HTTP, as the plugin does at 27123, so the TLS handshake fails for real.
      const https = vault.endpoint.replace(/^http:/, 'https:');
      const outcome = await createVaultClient({
        ...vault.config(),
        endpoint: https,
        allowInsecureLoopback: false,
      }).probe();
      expect(outcome).toEqual({
        ok: false,
        message: `Chrome could not connect to ${https}. If Obsidian is open, either this computer does not trust the plugin’s certificate or this port is the plugin’s HTTP server. Choose HTTP in Settings and turn on the plugin’s non-encrypted (HTTP) server.`,
      });
    });

    it('names a plain HTTP endpoint nothing answers at, and the server to turn on', async () => {
      const gone = new VaultEmulator();
      await gone.start();
      await gone.stop();
      const outcome = await createVaultClient({
        ...vault.config(),
        endpoint: gone.endpoint,
      }).probe();
      expect(outcome).toEqual({
        ok: false,
        message: `Chrome could not connect to ${gone.endpoint}. Check Obsidian is open, the Local REST API plugin’s non-encrypted (HTTP) server is on, and the port is the one its HTTP address shows.`,
      });
    });

    it('says a vault that never answers did not answer in time', async () => {
      const outcome = await createVaultClient(vault.config(), {
        fetch: hanging,
        timeoutMs: 50,
      }).probe();
      expect(outcome.message).toBe(
        `The vault at ${vault.endpoint} did not answer within 0.05 seconds. Check Obsidian is open and responding.`,
      );
    });

    it('never blames the connection for a read the caller, or a settings change, cancelled', async () => {
      const controller = new AbortController();
      const cancelled = createVaultClient(vault.config(), { fetch: hanging }).probe(
        controller.signal,
      );
      controller.abort();
      expect((await cancelled).message).toBe(generic);
      // The background cancels with its own controller, which the caller's signal does not show.
      const background = new AbortController();
      const viaBackground = createVaultClient(
        { ...vault.config(), endpoint: 'https://127.0.0.1:27124', allowInsecureLoopback: false },
        {
          fetch: (input, init) =>
            hanging(input, {
              ...init,
              signal: AbortSignal.any([background.signal, ...(init?.signal ? [init.signal] : [])]),
            }),
        },
      ).probe();
      background.abort();
      expect((await viaBackground).message).toBe(generic);
      // Nor one the background cancels with a reason of its own: its signal reaches fetch
      // directly, and fetch rejects with that reason in place of an AbortError.
      const reasoned = new AbortController();
      const withReason = createVaultClient(vault.config(), {
        fetch: (input, init) =>
          hanging(input, {
            ...init,
            signal: AbortSignal.any([reasoned.signal, ...(init?.signal ? [init.signal] : [])]),
          }),
      }).probe();
      reasoned.abort(new Error('Settings changed.'));
      expect((await withReason).message).toBe(generic);
    });

    it('keeps the general words for a connection that breaks after the vault answered', async () => {
      const broken = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start: (stream) => stream.error(new TypeError('network error')),
            }),
            { status: 200 },
          ),
      );
      expect((await createVaultClient(vault.config(), { fetch: broken }).probe()).message).toBe(
        generic,
      );
    });
  });

  it.each([
    { endpoint: 'https://example.com:443' },
    { endpoint: 'https://localhost:27124' },
    { endpoint: 'https://127.0.0.1:27124/vault/foo' },
    { endpoint: 'https://secret@127.0.0.1:27124' },
    { endpoint: 'https://2130706433:27124' },
    { endpoint: 'https://127.0.0.1:27124?redirect=example.com' },
    { endpoint: 'https://127.0.0.1:99999' },
    { allowInsecureLoopback: false },
    { folder: '../outside' },
    { folder: 'Zombie Hand/%2foutside' },
    { folder: '.obsidian/plugins' },
    { folder: 'Zombie Hand\\outside' },
    { folder: '/absolute' },
    { folder: 'Zombie Hand/' },
    { apiKey: 'bad\r\nInjected: true' },
    { apiKey: '' },
  ])('rejects unsafe connection/path settings without network access: %j', async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createVaultClient({ ...vault.config(), ...override }, { fetch: fetcher });
    expect((await client.probe()).ok).toBe(false);
    expect((await client.ensureCapture(capture())).status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
