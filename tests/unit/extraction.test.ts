// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.org/article"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractCandidate,
  extractPage,
  extractSelection,
  pageByline,
  passageLink,
  publicWebUrl,
  publishedDate,
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

/** Chrome's caret at the pointer: in the `at`th child of the element `selector` finds. */
function caret(selector: string, offset: number, at = 0): void {
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: () => ({ offsetNode: document.querySelector(selector)?.childNodes[at], offset }),
  });
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
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: undefined });
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

  it('reports where the browser paints a selection, past the trimmed evidence', () => {
    fixture('<p id="text">Grab these words and more.</p>', '#text');
    const range = document.createRange();
    range.setStart(target.firstChild as Node, 0);
    range.setEnd(target.firstChild as Node, 17);
    document.getSelection()?.addRange(range);
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return [new DOMRect(10, 20, this.toString().length * 8, 18)] as unknown as DOMRectList;
    });
    const capture = extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true });
    expect(capture?.candidate.text).toBe('Grab these words');
    expect(capture?.rectangles?.[0]?.width).toBe(16 * 8);
    // The trailing space is still highlighted on the page.
    expect(capture?.highlight).toEqual([expect.objectContaining({ x: 10, width: 17 * 8 })]);
  });

  it("grows each highlighted fragment to its own paragraph's line box, one box per line", () => {
    fixture(
      '<div id="text"><p style="line-height: 32px">First <b>bold</b> line</p><p style="line-height: 20px">Second para</p></div>',
      '#text',
    );
    const [first, second] = target.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(first?.firstChild as Node, 0);
    range.setEnd(second?.firstChild as Node, 11);
    document.getSelection()?.addRange(range);
    // Glyph boxes: 24px tall in the first paragraph, 16px in the second.
    const glyphs: Record<string, DOMRect> = {
      'First ': new DOMRect(10, 100, 48, 24),
      bold: new DOMRect(58, 100, 32, 24),
      ' line': new DOMRect(90, 100, 40, 24),
      'Second para': new DOMRect(10, 140, 88, 16),
    };
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const own = glyphs[this.toString()];
      return (own ? [own] : Object.values(glyphs)) as unknown as DOMRectList;
    });
    const capture = extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true });
    expect(capture?.highlight?.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(
      [
        // The first line also covers its line break, which the selection runs on past.
        { x: 10, y: 96, width: 120 + 24 / 4, height: 32 },
        { x: 10, y: 138, width: 88, height: 20 },
      ],
    );
  });

  it('highlights only the lines on screen', () => {
    fixture('<p id="text">Above the fold <b>and inside it</b></p>', '#text');
    const range = document.createRange();
    range.setStart(target.firstChild as Node, 0);
    range.setEnd(target.lastChild?.firstChild as Node, 13);
    document.getSelection()?.addRange(range);
    const glyphs: Record<string, DOMRect> = {
      'Above the fold ': new DOMRect(10, -200, 120, 24),
      'and inside it': new DOMRect(10, 100, 104, 24),
    };
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const own = glyphs[this.toString()];
      return (own ? [own] : Object.values(glyphs)) as unknown as DOMRectList;
    });
    const capture = extractCandidate(document, { x: 80, y: 60 }, { preferSelection: true });
    expect(capture?.highlight).toEqual([
      expect.objectContaining({ x: 10, y: 100, width: 104, height: 24 }),
    ]);
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

  it('finds an image under a transparent overlay laid over it, as a lightbox link is', () => {
    fixture(
      `<figure><div style="position:relative"><picture><img id="image" src="/globe.jpg" alt="Globe map"></picture>
       <a id="overlay" href="#img-3" aria-hidden="true" tabindex="-1" style="position:absolute;top:0;width:100%;height:100%"><button type="button" style="opacity:0">View image in fullscreen</button></a>
       </div><figcaption>Illustration: Example Graphics</figcaption></figure>`,
      '#overlay',
    );
    const image = document.querySelector('#image') as HTMLImageElement;
    Object.defineProperty(image, 'currentSrc', {
      configurable: true,
      value: 'https://images.example.org/globe.jpg',
    });
    const stack = (top: Element): Element[] => {
      const below: Element[] = [];
      for (let at: Element | null = image; at; at = at.parentElement) below.push(at);
      return [top, ...below];
    };
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack(target),
    });
    const capture = extractCandidate(document, { x: 80, y: 60 });
    expect(capture?.candidate.kind).toBe('image');
    expect(capture?.candidate.image?.url).toBe('https://images.example.org/globe.jpg');
    expect(capture?.candidate.text).toBe('Globe map — Illustration: Example Graphics');
    expect(capture?.target).toBe(image);

    // Nothing is seen through a layer readers are not told to skip, the hand's
    // own, one that draws over the image or is a field, more layers than a
    // lightbox lays, nor into an image the page hides. Each layer here is
    // hidden from readers, so only its own reason stops the lookup.
    const cover = (setup: (element: HTMLElement) => void, tag = 'div'): Element => {
      const element = document.createElement(tag);
      element.setAttribute('aria-hidden', 'true');
      setup(element);
      document.body.append(element);
      return element;
    };
    const parsed = (html: string): Element => {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      const element = holder.firstElementChild as Element;
      document.body.append(element);
      return element;
    };
    for (const over of [
      cover((element) => element.removeAttribute('aria-hidden')),
      cover((element) => element.setAttribute('data-zombie-hand-ui', '')),
      cover((element) => {
        element.style.boxShadow = 'inset 0 0 0 999px rgba(0, 0, 0, 0.5)';
      }),
      cover((element) => {
        element.style.setProperty('backdrop-filter', 'blur(8px)');
      }),
      ...['audio', 'canvas', 'embed', 'iframe', 'object', 'video'].map((tag) =>
        cover(() => {}, tag),
      ),
      parsed('<svg aria-hidden="true" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'),
      // The shape of a play icon, the element Chromium finds at the pointer.
      parsed('<svg aria-hidden="true" viewBox="0 0 1 1"><path d="M0 0L1 .5L0 1z"/></svg>')
        .firstElementChild as Element,
      parsed('<math aria-hidden="true"><mi>x</mi></math>'),
      cover((element) => {
        element.style.backgroundColor = 'rgb(255, 255, 255)';
      }),
      cover((element) => {
        element.style.backgroundImage = 'url("https://example.org/pattern.png")';
      }),
      cover((element) => {
        element.textContent = 'We use cookies.';
      }),
      cover((element) => {
        element.setAttribute('contenteditable', 'true');
      }),
    ]) {
      target = over;
      expect(extractCandidate(document, { x: 80, y: 60 })?.target, over.outerHTML).not.toBe(image);
    }
    // A scrim drawn by ::after, as Chromium reports it; jsdom computes no pseudo-element styles.
    const scrim = cover(() => {});
    const computed = window.getComputedStyle.bind(window);
    const pseudo = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element, part) =>
        element === scrim && part === '::after'
          ? ({ content: '""' } as CSSStyleDeclaration)
          : computed(element, part),
      );
    target = scrim;
    expect(extractCandidate(document, { x: 80, y: 60 })?.target).not.toBe(image);
    pseudo.mockRestore();
    expect(extractCandidate(document, { x: 80, y: 60 })?.target).toBe(image);
    const layers = Array.from({ length: 5 }, () => cover(() => {}));
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [...layers, image],
    });
    target = layers[0] as Element;
    expect(extractCandidate(document, { x: 80, y: 60 })?.target).not.toBe(image);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [...layers.slice(1), image],
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.target).toBe(image);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack(target),
    });
    target = document.querySelector('#overlay') as Element;
    image.style.opacity = '0';
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
  });

  it('keeps a link laid over a thumbnail as the link, as a card on a news front is', () => {
    fixture(
      '<div class="card" style="position:relative"><img id="thumb" src="/thumb.jpg" alt="Thumbnail"><h3>Story headline</h3><a id="stretched" href="/story" aria-label="Story headline" style="position:absolute;inset:0"></a></div>',
      '#stretched',
    );
    const image = document.querySelector('#thumb') as Element;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [target, image, image.parentElement, document.body, document.documentElement],
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate).toMatchObject({
      kind: 'link',
      url: 'https://example.org/story',
    });
  });

  it('takes the sentence at the pointer from a block too large to read whole, such as an essay in one table cell', () => {
    const filler = (label: string, count: number): string =>
      Array.from(
        { length: count },
        (_, index) =>
          `${label} paragraph ${index} goes on about work for a while, as essays do.<br><br>`,
      ).join('');
    fixture(
      `<table><tr><td id="essay"><font>${filler('Early', 500)}<blockquote>A quoted aside.</blockquote><div>A line laid out as a block.</div>Develop a habit of working on your own <a href="/x">projects</a>. Don't let "work"\nmean something other people tell you to do. If you do manage it, it will be yours.<br><br>${filler('Late', 500)}</font></td></tr></table>`,
      '#essay font',
    );
    expect(document.querySelector('#essay')?.textContent?.length).toBeGreaterThan(64_000);
    const words = document.querySelector('#essay a')?.nextSibling as Text;
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: words, offset: 30 }),
    });
    const capture = extractCandidate(document, { x: 80, y: 60 });
    // The line break in the page's source shows as a space, so it ends no sentence.
    expect(capture?.candidate.text).toBe(
      `Don't let "work" mean something other people tell you to do.`,
    );
    expect(capture?.candidate.context?.paragraph).toBe(
      `Develop a habit of working on your own projects. Don't let "work" mean something other people tell you to do. If you do manage it, it will be yours.`,
    );
  });

  it('reads a few thousand characters either side in a huge block with no blank lines', () => {
    const run = (label: string): string =>
      Array.from(
        { length: 1_000 },
        (_, index) => `<span>${label} sentence ${index} says a little more.</span> `,
      ).join('');
    fixture(
      `<p id="wall">${run('Early')}<span id="here">The pointer rests on this sentence.</span> ${run('Late')}</p>`,
      '#wall',
    );
    expect(target.textContent?.length).toBeGreaterThan(64_000);
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: document.querySelector('#here')?.firstChild, offset: 4 }),
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'The pointer rests on this sentence.',
    );
  });

  it('reads the row at the pointer in a cell of thousands of rows, without walking the whole cell', () => {
    const rows = (from: number): string =>
      Array.from(
        { length: 3_000 },
        (_, index) => `<div>Row ${from + index} holds its own words.</div>`,
      ).join('');
    fixture(
      `<table><tr><td id="rows">${rows(0)}<div id="here">The pointer rests on this row. It ends.</div>${rows(3_000)}</td></tr></table>`,
      '#here',
    );
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: document.querySelector('#here')?.firstChild, offset: 4 }),
    });
    target = document.querySelector('#rows') as Element;
    const matches = vi.spyOn(Element.prototype, 'matches');
    try {
      expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
        'The pointer rests on this row.',
      );
      // Reading the cell's first 2,048 nodes, then the row's paragraph: far fewer
      // checks than walking all 6,000 rows would take.
      expect(matches.mock.calls.length).toBeLessThan(9_000);
    } finally {
      matches.mockRestore();
    }
  });

  it('reads the line at the pointer in a code block of thousands of short spans', () => {
    const lines = Array.from(
      { length: 1_500 },
      () => `${Array.from({ length: 8 }, (_, word) => `<span>w${word}</span>`).join(' ')};\n`,
    ).join('');
    fixture(
      `<pre id="code">${lines}<span id="here">pointed</span> <span>words</span>;\n${lines}</pre>`,
      '#code',
    );
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: document.querySelector('#here')?.firstChild, offset: 2 }),
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe('pointed words;');
  });

  it('still ends a sentence at a line break the page shows, as preformatted text does', () => {
    fixture('<pre id="code">first line without a stop\nsecond line here</pre>', '#code');
    const words = target.firstChild as Text;
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: words, offset: 30 }),
    });
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe('second line here');
  });

  it('takes the sentence at the pointer from text set in plain divs and spans, as search results are', () => {
    fixture(
      '<div id="result"><div><span>https://shop.example › bundles</span></div><div id="snippet"><span>Explore the camera bundles at the first local store. Free shipping on most orders.</span></div><div><div id="label">What customers love</div><div id="love">Customers praise the fast shipping. Staff are <em>helpful</em> and kind.</div></div></div>',
      '#snippet span',
    );
    caret('#snippet span', 10);
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate).toMatchObject({
      kind: 'text',
      url: 'https://example.org/article',
      text: 'Explore the camera bundles at the first local store.',
    });
    // A line laid out as a block is its own paragraph, never run into the next.
    target = document.querySelector('#label') as Element;
    caret('#label', 4);
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'What customers love',
    );
    target = document.querySelector('#love') as Element;
    caret('#love', 4, 2);
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'Staff are helpful and kind.',
    );
    // Between the lines of a result, the pointer is over the result, and the
    // caret Chrome gives is in the line it lies nearest.
    target = document.querySelector('#result') as Element;
    caret('#love', 4);
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'Customers praise the fast shipping.',
    );
  });

  it('reads a chip or card set inline as a box of its own, never run into the next', () => {
    fixture(
      '<div id="row"><span id="weather" style="display: inline-block">Weather today in Paris</span><span id="flights" style="display: inline-flex">Sponsored cheap flights to Rome</span><span style="display: inline-grid">Your account settings</span></div>',
      '#weather',
    );
    caret('#weather', 4);
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'Weather today in Paris',
    );
    target = document.querySelector('#row') as Element;
    caret('#flights', 4);
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'Sponsored cheap flights to Rome',
    );
  });

  it('still slips off plain text when no caret lies under the pointer, or its lines lie far off', () => {
    fixture('<div id="here"></div><div id="there">Text somewhere else entirely.</div>', '#here');
    // No caret, as over an empty box or text with no caret given.
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    target = document.querySelector('#there') as Element;
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    // A caret Chrome put in a different block.
    target = document.querySelector('#here') as Element;
    caret('#there', 4);
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
    // Over the empty end of a box holding text, Chrome still gives a caret in its
    // nearest line, which lies well away from the pointer.
    target = document.querySelector('#there') as Element;
    expect(extractCandidate(document, { x: 80, y: 60 })?.candidate.text).toBe(
      'Text somewhere else entirely.',
    );
    expect(extractCandidate(document, { x: 80, y: 400 })).toBeNull();
    // The page itself is never the passage.
    target = document.body;
    expect(extractCandidate(document, { x: 80, y: 60 })).toBeNull();
  });

  it('takes plain text beside any of its lines, however many boxes an inline-heavy sentence draws', () => {
    fixture('<div id="text">Every word of this sentence sits in a box of its own.</div>', '#text');
    caret('#text', 4);
    const boxes = Array.from({ length: 150 }, (_, index) => new DOMRect(600, index * 5, 10, 4));
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      ...boxes,
      new DOMRect(60, 390, 50, 20),
    ] as unknown as DOMRectList);
    expect(extractCandidate(document, { x: 80, y: 400 })?.candidate.text).toBe(
      'Every word of this sentence sits in a box of its own.',
    );
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
    expect(extractPage(document)?.candidate.truncated).toBe(true);
    fixture('<main><button>Only a control</button></main>', 'main');
    expect(extractPage(document)?.candidate.text).toBe('Synthetic public article');
    expect(extractPage(document)?.candidate).not.toHaveProperty('truncated');
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

  it('mixes a translucent background over what lies beneath it', () => {
    fixture(
      '<div style="background-color: rgb(200, 220, 240)"><div style="background-color: rgba(0, 0, 0, 0.05)"><p id="text">Words</p></div></div>',
      '#text',
    );
    expect(readingStyle(target, document)?.background).toBe('rgb(190, 209, 228)');
    fixture(
      '<div style="background-color: rgba(0, 0, 0, 0.5)"><p id="text">Words</p></div>',
      '#text',
    );
    expect(readingStyle(target, document)?.background).toBe('rgb(128, 128, 128)');
  });
});

describe('a passage that stands on its own', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  function select(node: Node, from: number, to: number): void {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }

  it('links straight to the passage with a text fragment the page can match', () => {
    expect(passageLink('https://example.org/a', 'Short passage, kept whole')).toBe(
      'https://example.org/a#:~:text=Short%20passage%2C%20kept%20whole',
    );
    expect(
      passageLink(
        'https://example.org/a?x=1#part',
        'one two three four five six seven eight nine-ten…',
      ),
    ).toBe(
      'https://example.org/a?x=1#part:~:text=one%20two%20three%20four,six%20seven%20eight%20nine%2Dten',
    );
    // An existing directive is replaced, never stacked.
    expect(passageLink('https://example.org/a#:~:text=old', 'new words')).toBe(
      'https://example.org/a#:~:text=new%20words',
    );
    expect(passageLink('https://example.org/a', '  ')).toBeUndefined();
  });

  it('reads a heading broken across lines as words, without what it hides', () => {
    fixture(
      `<h1>The curious<br>field journal.<span hidden>Permalink</span></h1>
       <p id="text">Some background first. I am relieved this changed completely. Then more.</p>`,
      '#text',
    );
    select(target.firstChild as Node, 23, 60);
    expect(extractSelection(document)?.candidate.context?.heading).toBe(
      'The curious field journal.',
    );
  });

  it('records the heading above a selection and the paragraph around it', () => {
    fixture(
      `<nav><h2>Site menu</h2></nav><h2>The barrier was broken <a href="#b">#</a></h2>
       <p id="text">Some background first. I am relieved this changed completely. Then more.</p>`,
      '#text',
    );
    const node = target.firstChild as Node;
    select(node, 23, 60);
    const passage = extractSelection(document)?.candidate;
    expect(passage?.text).toBe('I am relieved this changed completely');
    expect(passage?.context).toEqual({
      heading: 'The barrier was broken',
      paragraph: 'Some background first. I am relieved this changed completely. Then more.',
    });
    expect(passage?.passageUrl).toBe(
      'https://example.org/article#:~:text=I%20am%20relieved%20this%20changed%20completely',
    );
  });

  it('leaves out a paragraph that adds nothing, and the context of a page without headings', () => {
    fixture('<p id="text">The whole paragraph is the passage.</p>', '#text');
    select(target.firstChild as Node, 0, 35);
    const passage = extractSelection(document)?.candidate;
    expect(passage?.text).toBe('The whole paragraph is the passage.');
    expect(passage).not.toHaveProperty('context');
    expect(passage?.passageUrl).toContain(':~:text=');
  });

  it('keeps a window of a long paragraph centred on the passage', () => {
    fixture(
      `<p id="text">${'Before. '.repeat(300)}The pointed passage sits here.${' After.'.repeat(300)}</p>`,
      '#text',
    );
    const node = target.firstChild as Node;
    const start = (node.textContent ?? '').indexOf('The pointed');
    select(node, start, start + 30);
    const paragraph = extractSelection(document)?.candidate.context?.paragraph ?? '';
    expect(paragraph.length).toBeLessThanOrEqual(1_500);
    expect(paragraph.startsWith('…') && paragraph.endsWith('…')).toBe(true);
    expect(paragraph).toContain('The pointed passage sits here.');
  });

  it('gives a pointed sentence the same context as a selection', () => {
    fixture(
      '<h3>Section</h3><p id="text">First sentence. The pointed sentence matters! Last.</p>',
      '#text',
    );
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: target.firstChild, offset: 20 }),
    });
    const passage = extractCandidate(document, { x: 80, y: 60 })?.candidate;
    expect(passage?.text).toBe('The pointed sentence matters!');
    expect(passage?.context?.heading).toBe('Section');
    expect(passage?.context?.paragraph).toContain('First sentence.');
  });

  it('keeps a publication date as the page wrote it, in any time zone, and never guesses one', () => {
    const zone = process.env.TZ;
    try {
      for (const tz of ['Australia/Sydney', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = tz;
        const dates = Object.fromEntries(
          [
            '2024-03-05',
            '2024-03-05T22:00:00-08:00',
            '2024-03-05T23:30:00+11:00',
            'March 5, 2024',
            'Tue Mar 05 2024',
            '5 March 2024',
            'Oct 2024',
            '2024-03',
            '2024-02-30',
            'Posted on 12 May',
            'Section 12',
            'Season 3',
            '1',
            '',
          ].map((value) => [value, publishedDate(value)]),
        );
        expect(dates, tz).toEqual({
          '2024-03-05': '2024-03-05',
          '2024-03-05T22:00:00-08:00': '2024-03-05',
          '2024-03-05T23:30:00+11:00': '2024-03-05',
          'March 5, 2024': '2024-03-05',
          'Tue Mar 05 2024': '2024-03-05',
          '5 March 2024': '2024-03-05',
          'Oct 2024': '',
          '2024-03': '',
          '2024-02-30': '',
          'Posted on 12 May': '',
          'Section 12': '',
          'Season 3': '',
          '1': '',
          '': '',
        });
      }
    } finally {
      process.env.TZ = zone;
    }
  });

  it('finds the heading a passage sits under on a page with thousands of headings', () => {
    fixture(
      `${Array.from({ length: 2_400 }, (_, index) => `<h2>Section ${index + 1}</h2><p>Text ${index + 1}.</p>`).join('')}
       <p id="text">Some background first. I am relieved this changed completely. Then more.</p>`,
      '#text',
    );
    select(target.firstChild as Node, 23, 60);
    expect(extractSelection(document)?.candidate.context?.heading).toBe('Section 2400');
  });

  it('reads who wrote the page from its metadata, never trusting a URL as a name', () => {
    document.head.innerHTML = `<meta property="og:site_name" content="Example Weekly">
      <meta property="article:author" content="https://example.org/people/ada">
      <meta property="article:published_time" content="2024-12-31T09:30:00Z">
      <script type="application/ld+json">{"@graph":[{"author":{"name":"Ada Lovelace"}}]}</script>
      <script type="application/ld+json">{ not json</script>`;
    expect(pageByline(document)).toEqual({
      author: 'Ada Lovelace',
      site: 'Example Weekly',
      published: '2024-12-31',
    });
    document.head.innerHTML = '<meta name="date" content="not a date">';
    expect(pageByline(document)).toBeUndefined();
    fixture('<main><p>Body text that is long enough.</p></main>', 'main');
    document.head.innerHTML = '<meta name="author" content="Grace Hopper">';
    expect(extractPage(document)?.candidate.byline).toEqual({ author: 'Grace Hopper' });
  });
});

describe('sentence boundaries', () => {
  it('handles start, end and line breaks without collecting neighboring paragraphs', () => {
    expect(sentenceAt('First. Second! Third?', 9)).toBe('Second!');
    expect(sentenceAt('Line one\nLine two', 14)).toBe('Line two');
    expect(sentenceAt('Only sentence', 100)).toBe('Only sentence');
  });
});
