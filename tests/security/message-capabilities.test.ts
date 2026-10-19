import { describe, expect, it } from 'vitest';
import {
  candidateSchema,
  contentMessageSchema,
  safeUrlSchema,
  trustedMessageSchema,
} from '../../src/core/contracts';
import { boundedMessage, publicMediaUrl } from '../../src/core/domain/security';

describe('untrusted message capability boundary', () => {
  it.each([
    'SAVE_SETTINGS',
    'FORGET_KEY',
    'PROBE_VAULT',
    'IMPORT_VAULT',
    'SET_LIFECYCLE',
    'PREPARE_MODEL',
    'GET_STATE',
    'SET_ACTIVATION',
    'BEGIN_ACTIVATION',
    'GRANT_MEDIA_ORIGIN',
    'REVOKE_MEDIA_ORIGIN',
  ])('does not expose %s to content scripts', (type) => {
    expect(contentMessageSchema.safeParse({ v: 1, type }).success).toBe(false);
  });
  it('rejects caller-supplied destinations, credentials and extra command authority', () => {
    const candidate = {
      kind: 'text',
      title: 'Synthetic fixture',
      url: 'https://example.com/article',
      text: 'A bounded thought',
    };
    expect(candidateSchema.safeParse({ ...candidate, vaultPath: '../../outside.md' }).success).toBe(
      false,
    );
    expect(
      candidateSchema.safeParse({ ...candidate, headers: { Authorization: 'fixture-only' } })
        .success,
    ).toBe(false);
    expect(
      contentMessageSchema.safeParse({
        v: 1,
        type: 'ARM',
        candidate,
        pageUrl: candidate.url,
        tabId: 123,
      }).success,
    ).toBe(false);
    expect(
      trustedMessageSchema.safeParse({
        v: 1,
        type: 'PROBE_VAULT',
        endpoint: 'https://untrusted.example',
      }).success,
    ).toBe(false);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,hostile',
    'file:///tmp/a',
    'https://user:secret@example.com/',
    'chrome://settings',
  ])('rejects executable, private or credential-bearing source %s', (url) => {
    expect(safeUrlSchema.safeParse(url).success).toBe(false);
  });
  it('requires YouTube video identity to agree with the source', () => {
    const candidate = {
      kind: 'youtube',
      title: 'Synthetic video',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      text: '',
      video: {
        id: 'abcdefghijz',
        seconds: 20,
        transcript: { status: 'unavailable', cues: [], provenance: 'youtube-panel' },
      },
    };
    expect(candidateSchema.safeParse(candidate).success).toBe(false);
    expect(
      candidateSchema.safeParse({
        ...candidate,
        url: 'https://youtube.com.evil.example/watch?v=abcdefghijz',
      }).success,
    ).toBe(false);
  });
  it('bounds incoming serialized data and rejects cyclic or absent messages', () => {
    expect(boundedMessage({ text: 'x'.repeat(400_000) })).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(boundedMessage(cyclic)).toBe(false);
    expect(boundedMessage(undefined)).toBe(false);
    expect(boundedMessage({ v: 1, type: 'CONTENT_STATUS' })).toBe(true);
  });
});

describe('public media origin boundary', () => {
  it.each([
    'http://example.com/a.png',
    'https://127.0.0.1/a.png',
    'https://2130706433/a.png',
    'https://0x7f000001/a.png',
    'https://[::1]/a.png',
    'https://localhost/a.png',
    'https://localhost./a.png',
    'https://camera.local./a.png',
    'https://*.example.com/a.png',
    'https://api.local/a.png',
    'https://api.internal/a.png',
    'https://user:pass@example.com/a.png',
    'https://example.com:8443/a.png',
    'data:image/png;base64,a',
  ])('rejects restricted media destination %s', (url) => {
    expect(() => publicMediaUrl(url)).toThrow();
  });
  it('admits ordinary HTTPS image URLs without inventing a DNS-resolution guarantee', () => {
    expect(publicMediaUrl('https://images.example.com/flower.png?width=800').origin).toBe(
      'https://images.example.com',
    );
  });
});
