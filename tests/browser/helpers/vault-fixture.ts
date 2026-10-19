import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync } from 'node:zlib';

/** Synthetic protocol fixture. This is not the Obsidian plugin or a real vault. */
export interface VaultFixture {
  origin: string;
  key: string;
  files: Map<string, Buffer>;
  requests: { method: string; path: string; authorized: boolean; conditional: boolean }[];
  close(): Promise<void>;
}

function chunk(kind: string, bytes: Buffer): Buffer {
  const data = Buffer.concat([Buffer.from(kind), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, checksum]);
}

/** A flat synthetic image makes accidental overlay pixels easy to detect. */
export function fixturePng(width = 240, height = 120): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      raw[offset] = 31;
      raw[offset + 1] = 137;
      raw[offset + 2] = 91;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const articleHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The curious field journal</title><style>
body{margin:0;padding:70px 80px;background:#f3efe5;color:#233b31;font-family:Georgia,serif}main{max-width:740px}.eyebrow{font:12px system-ui;letter-spacing:2px;text-transform:uppercase;color:#627c6c}h1{font-size:48px;line-height:1.08;margin:18px 0 34px}p{font-size:21px;line-height:1.55;max-width:680px}figure{position:absolute;top:510px;left:80px;margin:0}img{display:block;width:240px;height:120px}figcaption{font:13px system-ui;margin-top:10px;color:#627c6c}#hostile{margin-top:315px}
</style></head><body><main><div class="eyebrow">Synthetic public browser fixture</div><h1>The curious<br>field journal.</h1><p id="dog">A young dog runs through the park chasing a bright tennis ball.</p><p id="database">Database transactions use conditional writes to prevent accidental overwriting.</p><figure><img id="fern" src="/fern.png" alt="A synthetic green fern specimen"><figcaption>A flat green test image — no private browsing data.</figcaption></figure><p id="hostile">&lt;script&gt;window.privateData = 'stolen'&lt;/script&gt; is quoted research evidence.</p><input id="private-field" value="A form field must never be captured"></main></body></html>`;

export const youtubeHtml = `<!doctype html><html><head><title>Synthetic caption lesson - YouTube</title><style>body{margin:60px;font:18px system-ui;background:#fafafa}video{width:640px;height:280px;background:#364949}ytd-transcript-segment-renderer{display:block;margin:8px}.segment-timestamp{display:inline-block;width:80px}.segment-text{display:inline}</style></head><body><ytd-watch-metadata><h1>Synthetic caption lesson</h1></ytd-watch-metadata><div id="movie_player"><video class="html5-main-video"></video></div><ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"><ytd-transcript-segment-renderer><span class="segment-timestamp">0:30</span><span class="segment-text">The octopus changes colour to blend into the coral reef.</span></ytd-transcript-segment-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">0:45</span><span class="segment-text">Its camouflage hides it from passing predators.</span></ytd-transcript-segment-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">1:00</span><span class="segment-text">Each arm can explore its surroundings independently.</span></ytd-transcript-segment-renderer></ytd-engagement-panel-section-list-renderer></body></html>`;

export async function startVaultFixture(): Promise<VaultFixture> {
  const files = new Map<string, Buffer>();
  const key = 'synthetic-browser-test-key-not-a-secret';
  const requests: VaultFixture['requests'] = [];
  const etag = (bytes: Buffer): string => `"${createHash('sha256').update(bytes).digest('hex')}"`;
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'ETag');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization,Content-Type,If-Match,If-None-Match',
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    if (path === '/article') {
      response.setHeader('Content-Type', 'text/html');
      response.end(articleHtml);
      return;
    }
    if (path === '/fern.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(fixturePng());
      return;
    }
    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${key}`;
    requests.push({
      method: request.method ?? '',
      path,
      authorized,
      conditional: Boolean(request.headers['if-match'] || request.headers['if-none-match']),
    });
    if (!authorized) {
      response.writeHead(401);
      response.end('Authentication required');
      return;
    }
    if (path === '/') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ authenticated: true, service: 'Synthetic browser test fixture' }),
      );
      return;
    }
    if (!path.startsWith('/vault/')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = path.slice('/vault/'.length);
    if (request.method === 'GET') {
      if (file.endsWith('/')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            files: [...files.keys()]
              .filter((entry) => entry.startsWith(file))
              .map((entry) => entry.slice(file.length)),
          }),
        );
        return;
      }
      const existing = files.get(file);
      if (!existing) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('ETag', etag(existing));
      response.end(existing);
      return;
    }
    if (request.method === 'PUT') {
      const existing = files.get(file);
      if (
        (request.headers['if-none-match'] === '*' && existing) ||
        (request.headers['if-match'] &&
          (!existing || request.headers['if-match'] !== etag(existing)))
      ) {
        response.writeHead(412);
        response.end('Precondition failed');
        request.resume();
        return;
      }
      const pieces: Buffer[] = [];
      let size = 0;
      for await (const piece of request) {
        size += (piece as Buffer).byteLength;
        if (size > 16 * 1024 * 1024) {
          response.writeHead(413);
          response.end();
          return;
        }
        pieces.push(Buffer.from(piece));
      }
      const bytes = Buffer.concat(pieces);
      files.set(file, bytes);
      response.setHeader('ETag', etag(bytes));
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    key,
    files,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
