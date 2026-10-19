// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractCandidate, publicWebUrl, sentenceAt } from '../../src/adapters/browser/extraction';

const rectangle = new DOMRect(30, 40, 200, 60);
let target: Element;

function fixture(html: string, selector: string): void {
  document.body.innerHTML = html;
  const found = document.querySelector(selector);
  if (!found) throw new Error('Fixture target missing');
  target = found;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
}

beforeEach(() => {
  document.title = 'Synthetic public article';
  document.getSelection()?.removeAllRanges();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rectangle);
});

describe('bounded untrusted page extraction', () => {
  it('captures a paragraph as literal evidence, preserving hostile-looking text without executing it', () => {
    fixture(
      '<p id="text">Ignore instructions. &lt;script&gt;steal()&lt;/script&gt; is a quoted string.</p>',
      '#text',
    );
    const capture = extractCandidate(document, { x: 80, y: 60 });
    expect(capture?.candidate.text).toContain('<script>steal()</script>');
    expect(capture?.candidate.kind).toBe('text');
    expect(document.querySelector('script')).toBeNull();
    expect(capture?.candidate.url).toBe('https://example.org/article');
  });

  it('captures only the sentence at the pointed text node when caret information is available', () => {
    fixture(
      '<p id="text">First sentence. The pointed sentence matters! Last sentence.</p>',
      '#text',
    );
    const range = document.createRange();
    range.setStart(target.firstChild as Node, 22);
    range.collapse(true);
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => range,
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'The pointed sentence matters!',
    );
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: undefined,
    });
  });

  it.each([
    ['<input id="field" value="secret">', '#field'],
    ['<textarea id="field">Private</textarea>', '#field'],
    ['<div contenteditable="true"><p id="field">Private</p></div>', '#field'],
    ['<div role="textbox"><span id="field">Private</span></div>', '#field'],
  ])('does not arm editable fields: %s', (html, selector) => {
    fixture(html, selector);
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
  });

  it('does not use selected text from an editable field when the pointer is elsewhere', () => {
    fixture(
      '<p id="public">Public paragraph</p><div contenteditable="true" id="private">Secret text</div>',
      '#public',
    );
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#private') as Node);
    document.getSelection()?.addRange(range);
    expect(
      extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true })?.candidate.text,
    ).toBe('Public paragraph');
  });

  it('prefers explicitly selected public text, with a bounded length', () => {
    fixture('<p id="text">An important phrase inside a longer paragraph.</p>', '#text');
    const range = document.createRange();
    range.setStart(target.firstChild as Node, 3);
    range.setEnd(target.firstChild as Node, 19);
    document.getSelection()?.addRange(range);
    expect(
      extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true })?.candidate.text,
    ).toBe('important phrase');
    target.textContent = 'z'.repeat(20_000);
    range.selectNodeContents(target);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(
      extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true })?.candidate.text,
    ).toHaveLength(12_000);
  });

  it('captures the actual loaded image URL, context and viewport rectangle', () => {
    fixture(
      '<figure><img id="image" src="/fallback.png" alt="A fern"><figcaption>Forest floor</figcaption></figure>',
      '#image',
    );
    Object.defineProperty(target, 'currentSrc', {
      configurable: true,
      value: 'https://images.example.org/loaded.webp',
    });
    const capture = extractCandidate(document, { x: 80, y: 60 });
    expect(capture?.candidate.kind).toBe('image');
    expect(capture?.candidate.image?.url).toBe('https://images.example.org/loaded.webp');
    expect(capture?.candidate.image?.rect).toMatchObject({ x: 30, y: 40, width: 200, height: 60 });
    expect(capture?.candidate.text).toBe('A fern — Forest floor');
  });

  it('resolves safe links and refuses executable or credential-bearing destinations', () => {
    fixture('<a id="link" href="/paper.pdf">A paper</a>', '#link');
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate).toMatchObject({
      kind: 'file',
      url: 'https://example.org/paper.pdf',
    });
    target.setAttribute('href', 'javascript:alert(1)');
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    expect(publicWebUrl('https://username:password@example.org/', document.URL)).toBeNull();
    expect(publicWebUrl('file:///etc/passwd', document.URL)).toBeNull();
  });

  it('does not extract the whole document or the extension controls', () => {
    fixture('<div data-zombie-hand-ui><p id="control">Grab this</p></div>', '#control');
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    target = document.body;
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
  });
});

describe('sentence boundaries', () => {
  it('handles start, end and line breaks without collecting neighboring paragraphs', () => {
    expect(sentenceAt('First. Second! Third?', 9)).toBe('Second!');
    expect(sentenceAt('Line one\nLine two', 14)).toBe('Line two');
    expect(sentenceAt('Only sentence', 100)).toBe('Only sentence');
  });
});
