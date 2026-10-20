// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article"}
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractCandidate,
  extractPage,
  extractSelection,
  publicWebUrl,
  readingStyle,
  sentenceAt,
} from '../../src/adapters/browser/extraction';

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
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: undefined });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => rectangle,
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [rectangle],
  });
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

  it('captures a whole sentence across inline nodes and highlights the returned evidence', () => {
    fixture(
      '<p id="paragraph">First sentence. The <strong id="word">pointed</strong> sentence <em>matters!</em> Last sentence.</p>',
      '#word',
    );
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: target.firstChild, offset: 3 }),
    });
    const evidence: string[] = [];
    const firstLine = new DOMRect(42, 48, 210, 18);
    const secondLine = new DOMRect(42, 68, 85, 18);
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      evidence.push(this.toString());
      return [firstLine, secondLine, secondLine] as unknown as DOMRectList;
    });
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(42, 48, 210, 38),
    );
    const capture = extractCandidate(document, { x: 80, y: 60 });
    expect(capture?.candidate.text).toBe('The pointed sentence matters!');
    expect(capture?.target.id).toBe('paragraph');
    expect(evidence).toEqual(['The pointed sentence matters!']);
    expect(capture?.rectangle).toMatchObject({ x: 42, y: 48, width: 210, height: 38 });
    expect(capture?.rectangles).toHaveLength(2);
    expect(capture?.rectangles?.[1]).toMatchObject({ x: 42, y: 68, width: 85, height: 18 });
  });

  it('respects visible line boundaries around inline formatting', () => {
    fixture(
      '<p>Earlier line<br>Focus <strong id="word">across</strong> formatting, please.<br>Later line</p>',
      '#word',
    );
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: target.firstChild, offset: 2 }),
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'Focus across formatting, please.',
    );
  });

  it('truncates both captured text and its DOM highlight at the same bounded endpoint', () => {
    fixture(`<p id="text">${'Alpha   '.repeat(700)}</p>`, '#text');
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: target.firstChild, offset: 4 }),
    });
    let highlighted = '';
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      highlighted = this.toString().replace(/\s+/gu, ' ').trim();
      return [rectangle] as unknown as DOMRectList;
    });
    const capture = extractCandidate(document, { x: 80, y: 60 });
    expect(capture?.candidate.text).toBe(highlighted);
    expect(capture?.candidate.text.length).toBeLessThanOrEqual(1_600);
    expect(highlighted.length).toBeGreaterThan(1_590);
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

  it.each([
    '<div id="control">A generic container is not a text target.</div>',
    '<div><span id="control">Neither is an unscoped inline fragment.</span></div>',
    '<button><span id="control">Submit something</span></button>',
    '<a id="control" href="/action" role="button">Run an action</a>',
    '<details><summary id="control">Open a panel</summary></details>',
    '<nav><p id="control">Navigation controls</p></nav>',
    '<div role="slider"><p id="control">Change something</p></div>',
  ])('rejects generic page areas and active controls: %s', (html) => {
    fixture(html, '#control');
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
  });

  it('does not include hidden or editable descendants in paragraph evidence', () => {
    fixture(
      '<p id="text">Visible words <span hidden>Hidden secret</span><span style="display:none">CSS secret</span><span style="opacity:0">Transparent secret</span><input value="Private value"> finish here.</p>',
      '#text',
    );
    const capture = extractCandidate(document, { x: 80, y: 60 });
    expect(capture?.candidate.text).toBe('Visible words finish here.');
  });

  it('rejects a caret in a different block and an oversized source block', () => {
    fixture('<p id="text">Visible paragraph.</p><p id="other">Different paragraph.</p>', '#text');
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: document.querySelector('#other')?.firstChild, offset: 4 }),
    });
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: undefined,
    });
    target.textContent = 'x'.repeat(64_001);
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

  it('does not collect a private field between two public selection endpoints', () => {
    fixture(
      '<p id="public">Public paragraph</p><div contenteditable="true">Secret text</div><p id="end">Public ending</p>',
      '#public',
    );
    const range = document.createRange();
    range.setStart(target.firstChild as Node, 0);
    range.setEnd(document.querySelector('#end')?.firstChild as Node, 6);
    document.getSelection()?.addRange(range);
    expect(
      extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true })?.candidate.text,
    ).toBe('Public paragraph');
  });

  it.each(['display:none', 'visibility:hidden', 'opacity:0'])(
    'ignores a selection hidden by an ancestor with %s',
    (style) => {
      fixture(
        `<p id="public">Public paragraph</p><div style="${style}"><p id="hidden">Hidden synthetic text</p></div>`,
        '#public',
      );
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#hidden') as Node);
      document.getSelection()?.addRange(range);
      expect(
        extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true })?.candidate.text,
      ).toBe('Public paragraph');
    },
  );

  it('ignores a programmatic selection when the native range has no rendered rectangles', () => {
    fixture('<p id="public">Public paragraph</p><p id="other">Unrendered selection</p>', '#public');
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#other') as Node);
    document.getSelection()?.addRange(range);
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
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

  it('keeps a selected inline phrase and its highlight aligned', () => {
    fixture('<p id="text">Keep <strong>this phrase</strong> and this tail.</p>', '#text');
    const range = document.createRange();
    range.setStart(target.querySelector('strong')?.firstChild as Node, 0);
    range.setEnd(target.lastChild as Node, 9);
    document.getSelection()?.addRange(range);
    const highlighted: string[] = [];
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      highlighted.push(this.toString());
      return [rectangle] as unknown as DOMRectList;
    });
    const capture = extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true });
    expect(capture?.candidate.text).toBe('this phrase and this');
    expect(highlighted.at(-1)).toBe(capture?.candidate.text);
    expect(capture?.rectangles).toHaveLength(1);
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

describe('explicit selection and whole-page grabs', () => {
  it('keeps a selection when the pointer rests over a control or the extension', () => {
    fixture(
      '<p id="text">Keep this selected sentence.</p><nav><button id="menu">Menu</button></nav>',
      '#menu',
    );
    const paragraph = document.querySelector('#text') as Element;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    document.getSelection()?.addRange(range);
    expect(
      extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true })?.candidate.text,
    ).toBe('Keep this selected sentence.');
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    expect(extractSelection(document)?.candidate).toMatchObject({
      kind: 'text',
      url: 'https://example.org/article',
      text: 'Keep this selected sentence.',
    });
  });

  it('returns no selection for a collapsed, editable or control selection', () => {
    fixture(
      '<p id="text">Public words</p><div contenteditable="true" id="private">Secret</div>',
      '#text',
    );
    expect(extractSelection(document)).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#private') as Node);
    document.getSelection()?.addRange(range);
    expect(extractSelection(document)).toBeNull();
  });

  it('grabs a page as its link plus a bounded excerpt of visible reading text', () => {
    fixture(
      `<header><p>Site banner</p></header><nav><p>Home · About</p></nav>
       <main><h1>Keep the interesting part</h1><p>First   public paragraph.</p>
       <p style="display:none">Hidden paragraph</p><form><p>Form label</p><input value="secret"></form>
       <div contenteditable="true"><p>Draft text</p></div><aside><p>Related links</p></aside>
       <ul><li>One <p>nested</p></li></ul><footer><p>Copyright</p></footer></main>`,
      'main',
    );
    const page = extractPage(document);
    expect(page?.candidate).toMatchObject({
      kind: 'link',
      url: 'https://example.org/article',
      title: 'Synthetic public article',
    });
    expect(page?.candidate.text).toBe(
      'Keep the interesting part\n\nFirst public paragraph.\n\nOne\n\nnested',
    );
    expect(page?.target).toBe(document.body);
    expect(page?.rectangle).toMatchObject({ x: 0, y: 0 });
  });

  it('bounds the page excerpt and falls back to the title for a page without reading text', () => {
    fixture(`<main>${'<p>Twenty characters!! </p>'.repeat(400)}</main>`, 'main');
    const text = extractPage(document)?.candidate.text ?? '';
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text.endsWith('…')).toBe(true);
    fixture('<main><button>Only a control</button></main>', 'main');
    expect(extractPage(document)?.candidate.text).toBe('Synthetic public article');
  });

  it('skips banner chrome only when the page has no article or main landmark', () => {
    fixture('<header><p>Site banner</p></header><p id="body">Body text.</p>', '#body');
    expect(extractPage(document)?.candidate.text).toBe('Body text.');
    fixture('<article><header><h1>Article title</h1></header><p>Body.</p></article>', 'article');
    expect(extractPage(document)?.candidate.text).toBe('Article title\n\nBody.');
  });

  it('reads the visible reading style from the nearest opaque background', () => {
    fixture(
      '<div style="background-color: rgb(20, 22, 28)"><p id="text" style="color: rgb(220, 221, 228); font-family: Georgia">Dark words</p></div>',
      '#text',
    );
    expect(readingStyle(target, document)).toEqual({
      fontFamily: 'Georgia',
      color: 'rgb(220, 221, 228)',
      background: 'rgb(20, 22, 28)',
      fontSize: 16,
    });
  });
});

describe('sentence boundaries', () => {
  it('handles start, end and line breaks without collecting neighboring paragraphs', () => {
    expect(sentenceAt('First. Second! Third?', 9)).toBe('Second!');
    expect(sentenceAt('Line one\nLine two', 14)).toBe('Line two');
    expect(sentenceAt('Only sentence', 100)).toBe('Only sentence');
  });
});
