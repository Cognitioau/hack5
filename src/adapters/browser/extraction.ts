import type { CaptureCandidate } from '../../core/contracts/index';

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface TargetRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ExtractedCandidate {
  candidate: CaptureCandidate;
  rectangle: TargetRectangle;
  /** Visible text fragments for an exact highlight; media keeps its original rectangle. */
  rectangles?: TargetRectangle[];
  /** Where the browser paints a live selection, which can run past the trimmed evidence. */
  highlight?: TargetRectangle[];
  target: Element;
}

export interface ExtractionOptions {
  preferSelection?: boolean;
  special?: (document: Document, target: Element) => CaptureCandidate | null;
}

const BLOCK_SELECTOR = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,pre';
const EDITABLE_SELECTOR =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]';
const CONTROL_SELECTOR =
  'button,summary,nav,[inert],[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="combobox"],[role="menuitem"],[role="tab"],[role="option"]';
const OMITTED_SELECTOR =
  'script,style,noscript,template,[hidden],[aria-hidden="true"],[data-zombie-hand-ui]';
/** Page furniture never belongs in a whole-page excerpt. */
const PAGE_CHROME_SELECTOR =
  'nav,aside,form,dialog,footer,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="search"],[role="dialog"]';
const PAGE_BANNER_SELECTOR = 'header,[role="banner"]';
const PAGE_ROOT_SELECTOR = 'article,main,[role="main"]';
const MAX_PAGE_EXCERPT = 4_000;
const MAX_PAGE_BLOCKS = 400;
const MAX_TEXT = 12_000;
const MAX_SOURCE_TEXT = 64_000;
const MAX_SOURCE_NODES = 2_048;
/**
 * A paragraph read from a block too large to read whole reaches this far either
 * side, in characters and in nodes; the nodes, with the elements holding the
 * paragraph, stay within what collectText reads.
 */
const MAX_WINDOW_TEXT = 6_000;
const MAX_WINDOW_SIDE_NODES = (MAX_SOURCE_NODES - 128) / 2;
/** Transparent layers looked through to find an image under the pointer. */
const MAX_OVERLAYS = 4;
/**
 * Elements that draw at the pointer whatever their style: media and frames.
 * Fields are editable, SVG and MathML draw by their namespace, and an image
 * ends the lookup.
 */
const PAINTING_TAGS = new Set(['audio', 'canvas', 'embed', 'iframe', 'object', 'video']);
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const PARAGRAPH_SELECTOR = 'p,li,blockquote,dd,td,pre,figcaption';
const MAX_CONTEXT_PARAGRAPH = 1_500;
/** Headings looked at above a passage, nearest first, past page furniture and hidden ones. */
const MAX_HEADINGS = 200;
const MAX_LINKED_DATA = 200_000;

interface TextPiece {
  node: Text;
  nodeOffset: number;
  start: number;
  end: number;
}

interface TextMap {
  text: string;
  pieces: TextPiece[];
}

interface TextSpan {
  start: number;
  end: number;
  text: string;
}

export function cleanText(value: string, maximum = MAX_TEXT): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function publicWebUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isEditable(target: Element | null): boolean {
  return Boolean(target?.closest(EDITABLE_SELECTOR));
}

export function targetRectangle(element: Element, document: Document): TargetRectangle {
  const bounds = element.getBoundingClientRect();
  const window = document.defaultView;
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    viewportWidth: window?.innerWidth ?? document.documentElement.clientWidth,
    viewportHeight: window?.innerHeight ?? document.documentElement.clientHeight,
  };
}

function hiddenByPage(element: Element, document: Document): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = document.defaultView?.getComputedStyle(current);
    if (
      current.matches(OMITTED_SELECTOR) ||
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    )
      return true;
  }
  return false;
}

/**
 * A bounded, visible text map preserves offsets across inline formatting.
 * Only nodes in `within` (a selection) or in `only` (a paragraph window) are read.
 */
function collectText(
  document: Document,
  target: Element,
  within?: Range,
  only?: ReadonlySet<Node>,
): TextMap | null {
  if (hiddenByPage(target, document)) return null;
  let text = '';
  const pieces: TextPiece[] = [];
  let visited = 0;
  let invalid = false;
  const boundary = (): void => {
    if (text && !text.endsWith('\n')) text += '\n';
  };
  const visit = (node: Node): void => {
    if (invalid) return;
    // Only what is collected counts, so a passage in a huge container still reads.
    if (within && !within.intersectsNode(node)) return;
    if (only && !only.has(node)) return;
    visited += 1;
    if (visited > MAX_SOURCE_NODES || text.length > MAX_SOURCE_TEXT) {
      invalid = true;
      return;
    }
    if (node.nodeType === 3) {
      const value = node as Text;
      const start = within?.startContainer === node ? within.startOffset : 0;
      const end = within?.endContainer === node ? within.endOffset : value.length;
      // A line break in the page's source shows as a space unless the text keeps
      // its lines, so it ends no sentence. One character for one keeps offsets.
      const lines = /^(?:pre|pre-wrap|pre-line|break-spaces)$/u.test(
        (value.parentElement && document.defaultView?.getComputedStyle(value.parentElement))
          ?.whiteSpace ?? '',
      );
      const raw = value.data.slice(start, end);
      const part = lines ? raw : raw.replace(/[\n\r\f]/gu, ' ');
      if (text.length + part.length > MAX_SOURCE_TEXT) {
        invalid = true;
        return;
      }
      pieces.push({
        node: value,
        nodeOffset: start,
        start: text.length,
        end: text.length + part.length,
      });
      text += part;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (isEditable(element) || element.matches(CONTROL_SELECTOR)) {
      // An explicit selection crossing a private/control field is not public
      // evidence. Unselected paragraphs simply end at that boundary.
      if (within) invalid = true;
      boundary();
      return;
    }
    const style = document.defaultView?.getComputedStyle(element);
    if (
      element.matches(OMITTED_SELECTOR) ||
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    ) {
      boundary();
      return;
    }
    const nestedBlock = element !== target && element.matches(BLOCK_SELECTOR);
    if (element.tagName === 'BR' || nestedBlock) boundary();
    // The normal path captures a sentence in one semantic block. Only explicit
    // selection is allowed to collect multiple blocks.
    if (nestedBlock && !within) return;
    for (const child of element.childNodes) visit(child);
    if (nestedBlock) boundary();
  };
  visit(target);
  return invalid || !pieces.length ? null : { text, pieces };
}

/**
 * The nodes of the paragraph around a text node in a block too large to read
 * whole, such as an essay held in one table cell: the run of text between
 * blank lines (two line breaks), a nested block or a control, at most a few
 * thousand characters and a few hundred nodes either side, with the elements
 * holding them. Walked outward from the node, so a huge block costs no more
 * than its paragraph. Null when the node is not text inside the block.
 */
function paragraphWindow(block: Element, anchor: Node): Set<Node> | null {
  if (anchor.nodeType !== 3 || !block.contains(anchor)) return null;
  const view = block.ownerDocument.defaultView;
  const known = new Map<Element, boolean>();
  /** A nested block, control or field, or anything laid out as a block, such as one row of many `div`s. */
  const stops = (element: Element): boolean => {
    if (element === block) return false;
    let stop = known.get(element);
    if (stop === undefined) {
      stop =
        element.matches(BLOCK_SELECTOR) ||
        isEditable(element) ||
        element.matches(CONTROL_SELECTOR) ||
        !/^(?:inline|contents|none|ruby)/u.test(
          view?.getComputedStyle(element).display ?? 'inline',
        );
      known.set(element, stop);
    }
    return stop;
  };
  /** The nearest stop holding a node, else the block. */
  const holder = (node: Node): Element => {
    for (
      let at = node === block ? null : node.parentElement;
      at && at !== block;
      at = at.parentElement
    )
      if (stops(at)) return at;
    return block;
  };
  const home = holder(anchor);
  /** The nodes walked from the anchor one way, out to the farthest text the paragraph takes. */
  const side = (step: 1 | -1): Node[] => {
    const walker = block.ownerDocument.createTreeWalker(
      block,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    walker.currentNode = anchor;
    const passed: Node[] = [];
    const items: { kind: 'text' | 'line' | 'stop'; at: number; length: number; blank: boolean }[] =
      [];
    const item = (index: number) => {
      while (items.length <= index && items.at(-1)?.kind !== 'stop') {
        const node =
          passed.length < MAX_WINDOW_SIDE_NODES
            ? step === 1
              ? walker.nextNode()
              : walker.previousNode()
            : null;
        const at = passed.length;
        if (!node) {
          items.push({ kind: 'stop', at, length: 0, blank: false });
          break;
        }
        passed.push(node);
        if (node.nodeType === 3) {
          const text = node as Text;
          items.push(
            holder(text) === home
              ? { kind: 'text', at, length: text.length, blank: !text.data.trim() }
              : { kind: 'stop', at, length: 0, blank: false },
          );
        } else if (node.nodeType === 1) {
          const element = node as Element;
          // Other elements end nothing themselves: text held outside `home` is a stop.
          if (stops(element)) items.push({ kind: 'stop', at, length: 0, blank: false });
          else if (element.tagName === 'BR')
            items.push({ kind: 'line', at, length: 0, blank: false });
        }
      }
      return (
        items[Math.min(index, items.length - 1)] ?? { kind: 'stop', at: 0, length: 0, blank: false }
      );
    };
    let size = 0;
    let farthest = -1;
    for (let index = 0; ; index++) {
      const entry = item(index);
      if (entry.kind === 'stop' || size > MAX_WINDOW_TEXT) break;
      if (entry.kind === 'line') {
        // A line break with nothing but spaces between it and the next one makes a blank line.
        let ahead = index + 1;
        while (item(ahead).kind === 'text' && item(ahead).blank) ahead += 1;
        if (item(ahead).kind === 'line') break;
        continue;
      }
      size += entry.length;
      farthest = entry.at;
    }
    return passed.slice(0, farthest + 1);
  };
  const before = side(-1);
  const after = side(1);
  const nodes = new Set<Node>([anchor, ...before, ...after]);
  // collectText reaches the paragraph through the elements holding its ends.
  for (const end of [before.at(-1) ?? anchor, after.at(-1) ?? anchor])
    for (let at: Node | null = end; at && at !== block; at = at.parentNode) nodes.add(at);
  nodes.add(block);
  return nodes;
}

/** The text of a block, or of the paragraph around a node when the block is too large. */
function blockText(document: Document, block: Element, anchor: Node | null): TextMap | null {
  const whole = collectText(document, block);
  if (whole || !anchor || !block.contains(anchor)) return whole;
  const window = paragraphWindow(block, anchor);
  return window ? collectText(document, block, undefined, window) : null;
}

/** Normalize whitespace while retaining the exact DOM endpoints of the result. */
function boundedSpan(text: string, start: number, end: number, maximum: number): TextSpan {
  let result = '';
  let first = start;
  let last = start;
  let pendingSpace = false;
  for (let index = start; index < end; ) {
    const value = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const next = index + value.length;
    if (/\s/u.test(value)) {
      pendingSpace = result.length > 0;
    } else {
      const separator = pendingSpace ? ' ' : '';
      if (result.length + separator.length + value.length > maximum) break;
      if (!result) first = index;
      result += separator + value;
      last = next;
      pendingSpace = false;
    }
    index = next;
  }
  return { start: first, end: last, text: result };
}

function mappedRange(document: Document, map: TextMap, span: TextSpan): Range | null {
  const first = map.pieces.find((piece) => piece.end > span.start);
  const last = [...map.pieces].reverse().find((piece) => piece.start < span.end);
  if (!first || !last || !span.text) return null;
  const range = document.createRange();
  range.setStart(first.node, first.nodeOffset + Math.max(0, span.start - first.start));
  range.setEnd(last.node, last.nodeOffset + Math.min(last.end - last.start, span.end - last.start));
  return range;
}

function textGeometry(
  document: Document,
  target: Element,
  range: Range,
): Pick<ExtractedCandidate, 'rectangle' | 'rectangles'> {
  const fallback = targetRectangle(target, document);
  const boxes =
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  const rectangles: TargetRectangle[] = [];
  for (const box of boxes) {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.right <= 0 ||
      box.bottom <= 0 ||
      box.left >= fallback.viewportWidth ||
      box.top >= fallback.viewportHeight
    )
      continue;
    const rectangle = { ...fallback, x: box.x, y: box.y, width: box.width, height: box.height };
    if (
      !rectangles.some(
        (existing) =>
          Math.abs(existing.x - box.x) < 0.5 &&
          Math.abs(existing.y - box.y) < 0.5 &&
          Math.abs(existing.width - box.width) < 0.5 &&
          Math.abs(existing.height - box.height) < 0.5,
      )
    )
      rectangles.push(rectangle);
    if (rectangles.length >= 128) break;
  }
  const bounds =
    typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  const rectangle =
    bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0
      ? { ...fallback, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : fallback;
  return rectangles.length ? { rectangle, rectangles } : { rectangle };
}

function selectionCandidate(
  document: Document,
  point: ViewportPoint,
  preferSelection: boolean,
  pageUrl: string,
): ExtractedCandidate | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const target = container.nodeType === 1 ? (container as Element) : container.parentElement;
  if (
    !target ||
    isEditable(target) ||
    target.closest(CONTROL_SELECTOR) ||
    isEditable(selection.anchorNode?.parentElement ?? null) ||
    isEditable(selection.focusNode?.parentElement ?? null)
  )
    return null;
  const hasNativeRectangles = typeof range.getClientRects === 'function';
  const boxes = hasNativeRectangles
    ? Array.from(range.getClientRects()).filter(
        (box) =>
          [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
          box.width > 0 &&
          box.height > 0,
      )
    : [];
  // Programmatic selections in hidden subtrees can have a non-collapsed Range
  // while exposing no rendered text. Explicit selection may be offscreen, but
  // a native browser must still provide positive rendered fragments for it.
  if (hasNativeRectangles && boxes.length === 0) return null;
  if (
    !preferSelection &&
    !boxes.some(
      (box) =>
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom,
    )
  )
    return null;
  const map = collectText(document, target, range);
  if (!map) return null;
  const span = boundedSpan(map.text, 0, map.text.length, MAX_TEXT);
  const selectedRange = mappedRange(document, map, span);
  if (span.text.length < 2 || !selectedRange) return null;
  const highlight = selectionHighlight(document, map, targetRectangle(target, document));
  const geometry = textGeometry(document, target, selectedRange);
  return {
    candidate: {
      kind: 'text',
      url: pageUrl,
      title: cleanText(document.title || span.text, 300),
      text: span.text,
      ...passageDetails(document, pageUrl, selectedRange, span.text),
    },
    target,
    ...geometry,
    ...(highlight.length ? { highlight } : {}),
  };
}

/**
 * Where the browser paints a live selection, line by line. Chrome highlights a
 * text fragment over its whole line box, so each fragment grows to its own
 * element's line height; fragments of one line (bold words, links) merge, and
 * only lines inside the viewport are kept. Where the selection runs on past a
 * line's end, Chrome also paints the line break, about a space wide.
 */
function selectionHighlight(
  document: Document,
  map: TextMap,
  frame: TargetRectangle,
): TargetRectangle[] {
  const window = document.defaultView;
  const lineHeights = new Map<Element, number>();
  const boxes: { left: number; top: number; right: number; bottom: number; glyph: number }[] = [];
  for (const piece of map.pieces) {
    const range = document.createRange();
    range.setStart(piece.node, piece.nodeOffset);
    range.setEnd(piece.node, piece.nodeOffset + piece.end - piece.start);
    if (typeof range.getClientRects !== 'function') return [];
    const parent = piece.node.parentElement;
    let lineHeight = parent ? lineHeights.get(parent) : 0;
    if (parent && lineHeight === undefined) {
      // Browsers compute line-height to px, or leave it 'normal' (about the glyph box).
      const value = window?.getComputedStyle(parent).lineHeight ?? '';
      lineHeight = value.endsWith('px') ? Number.parseFloat(value) || 0 : 0;
      lineHeights.set(parent, lineHeight);
    }
    for (const box of range.getClientRects()) {
      if (
        ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.width <= 0 ||
        box.height <= 0
      )
        continue;
      // An outsized line height inherited from a container never blanks the page around the words.
      const height = Math.min(Math.max(box.height, lineHeight ?? 0), box.height * 2);
      const top = box.y + (box.height - height) / 2;
      if (
        box.right <= 0 ||
        top + height <= 0 ||
        box.left >= frame.viewportWidth ||
        top >= frame.viewportHeight
      )
        continue;
      boxes.push({
        left: box.left,
        top,
        right: box.right,
        bottom: top + height,
        glyph: box.height,
      });
    }
  }
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: typeof boxes = [];
  for (const box of boxes) {
    const line = lines.find((other) => {
      const overlap = Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top);
      const shorter = Math.min(other.bottom - other.top, box.bottom - box.top);
      const gap = Math.max(other.left, box.left) - Math.min(other.right, box.right);
      // Same line, and close enough that nothing unselected sits between them.
      return overlap > shorter / 2 && gap <= shorter;
    });
    if (!line) lines.push({ ...box });
    else {
      line.left = Math.min(line.left, box.left);
      line.right = Math.max(line.right, box.right);
      line.top = Math.min(line.top, box.top);
      line.bottom = Math.max(line.bottom, box.bottom);
      line.glyph = Math.max(line.glyph, box.glyph);
    }
  }
  const last = lines.at(-1);
  return lines.slice(0, 128).map((line) => ({
    ...frame,
    x: line.left,
    y: line.top,
    width: line.right - line.left + (line === last ? 0 : line.glyph / 4),
    height: line.bottom - line.top,
  }));
}

type Byline = NonNullable<CaptureCandidate['byline']>;
type PassageDetails = Pick<CaptureCandidate, 'context' | 'passageUrl' | 'byline'>;

/**
 * A link that opens the page scrolled to the passage, as a text fragment: the
 * whole passage when short, otherwise its first and last four words.
 */
export function passageLink(pageUrl: string, evidence: string): string | undefined {
  const words = evidence.replace(/…$/u, '').split(/\s+/u).filter(Boolean);
  if (!words.length) return undefined;
  // Dashes and commas are text-directive syntax, so they are escaped too.
  const encode = (part: string[]): string =>
    encodeURIComponent(part.join(' ')).replace(/-/gu, '%2D');
  const directive =
    words.length <= 8 ? encode(words) : `${encode(words.slice(0, 4))},${encode(words.slice(-4))}`;
  const url = new URL(pageUrl);
  const fragment = url.hash.replace(/:~:.*$/u, '');
  url.hash = '';
  const link = `${url.href}${fragment || '#'}:~:text=${directive}`;
  return link.length <= 4_000 ? link : undefined;
}

/** The nearest visible heading above a passage, skipping page furniture. */
function headingBefore(document: Document, node: Node): string | undefined {
  const headings = document.querySelectorAll(HEADING_SELECTOR);
  const before = (index: number): boolean =>
    Boolean(
      (headings[index]?.compareDocumentPosition(node) ?? 0) & node.DOCUMENT_POSITION_FOLLOWING,
    );
  // Headings come in page order, so the last one that starts before the passage is found by halving.
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (before(middle)) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= Math.max(0, low - MAX_HEADINGS); index--) {
    const heading = headings[index];
    if (!heading || heading.contains(node)) continue;
    if (heading.closest(PAGE_CHROME_SELECTOR) || hiddenByPage(heading, document)) continue;
    // Self-links such as "#" or "¶" trail many blog and docs headings.
    const text = cleanText(collectText(document, heading)?.text ?? '', 300).replace(
      /\s*[#¶§]$/u,
      '',
    );
    if (text) return text;
  }
  return undefined;
}

/** The paragraph a passage sits in, when there is more of it than the passage. */
function paragraphAround(document: Document, range: Range, evidence: string): string | undefined {
  const start =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const block = start?.closest(PARAGRAPH_SELECTOR);
  if (!block?.contains(range.endContainer) || block.closest(PAGE_CHROME_SELECTOR)) return undefined;
  const anchor =
    range.startContainer.nodeType === 1
      ? (range.startContainer.childNodes[range.startOffset] ?? range.startContainer)
      : range.startContainer;
  const text = cleanText(blockText(document, block, anchor)?.text ?? '', MAX_SOURCE_TEXT);
  if (text.length < evidence.length + 20 || evidence.length > MAX_CONTEXT_PARAGRAPH / 2)
    return undefined;
  if (text.length <= MAX_CONTEXT_PARAGRAPH) return text;
  // A long paragraph keeps a window centred on the passage.
  const at = Math.max(0, text.indexOf(evidence.slice(0, 60)));
  const room = MAX_CONTEXT_PARAGRAPH - 2;
  const from = Math.max(
    0,
    Math.min(at - Math.floor((room - evidence.length) / 2), text.length - room),
  );
  const window = text.slice(from, from + room);
  return `${from > 0 ? '…' : ''}${window}${from + window.length < text.length ? '…' : ''}`;
}

function linkedData(document: Document): Byline {
  const found: Byline = {};
  const name = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(name).filter(Boolean).slice(0, 3).join(', ');
    if (value && typeof value === 'object') {
      const named = (value as { name?: unknown }).name;
      if (typeof named === 'string') return named;
    }
    return '';
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    found.author ||= name(record.author) || undefined;
    if (typeof record.datePublished === 'string') found.published ||= record.datePublished;
    found.site ||= name(record.publisher) || undefined;
    visit(record['@graph'], depth + 1);
  };
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ).slice(0, 8)) {
    const text = script.textContent ?? '';
    if (text.length > MAX_LINKED_DATA) continue;
    try {
      visit(JSON.parse(text), 0);
    } catch {
      // A page's malformed metadata is simply not used.
    }
  }
  return found;
}

/**
 * A publication date as the page wrote it, as YYYY-MM-DD: an ISO date as it
 * stands, never moved into another time zone, or a written date that names its
 * day and year. Anything vaguer is left out rather than guessed.
 */
export function publishedDate(value: string): string {
  const text = value.trim().slice(0, 100);
  const day = (year: number, month: number, date: number): string => {
    const check = new Date(Date.UTC(year, month - 1, date));
    return check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === date
      ? `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`
      : '';
  };
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/u.exec(text);
  if (iso) return day(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const year = /(?<!\d)(1[6-9]\d{2}|2\d{3})(?!\d)/u.exec(text)?.[1];
  const parsed = new Date(Date.parse(text));
  if (!year || !Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== Number(year))
    return '';
  // A written date is read in local time, so its own day is the local one. The
  // parser accepts almost anything, so that day must be written there too.
  const named = parsed.getDate();
  if (!new RegExp(`(?<!\\d)0?${named}(?!\\d)`, 'u').test(text.replace(year, ''))) return '';
  return day(Number(year), parsed.getMonth() + 1, named);
}

/** Who wrote the page and where, read from its metadata; page text is never executed. */
export function pageByline(document: Document): Byline | undefined {
  const meta = (...names: string[]): string => {
    for (const name of names) {
      const element = document.querySelector(`meta[name="${name}"],meta[property="${name}"]`);
      const value = cleanText(element?.getAttribute('content') ?? '', 200);
      if (value) return value;
    }
    return '';
  };
  const linked = linkedData(document);
  const author = [meta('author', 'article:author', 'parsely-author'), linked.author ?? '']
    .map((value) => cleanText(value, 200))
    .find((value) => value && !/^https?:/iu.test(value));
  const site = cleanText(meta('og:site_name', 'application-name') || linked.site || '', 200);
  const published = publishedDate(
    meta('article:published_time', 'datePublished', 'date') || linked.published || '',
  );
  const byline: Byline = {
    ...(author ? { author } : {}),
    ...(site ? { site } : {}),
    ...(published ? { published } : {}),
  };
  return Object.keys(byline).length ? byline : undefined;
}

/** What a grabbed passage needs to stand on its own in the vault. */
function passageDetails(
  document: Document,
  pageUrl: string,
  range: Range,
  evidence: string,
): PassageDetails {
  const heading = headingBefore(document, range.startContainer);
  const paragraph = paragraphAround(document, range, evidence);
  const passageUrl = passageLink(pageUrl, evidence);
  const byline = pageByline(document);
  return {
    ...(heading || paragraph
      ? { context: { ...(heading ? { heading } : {}), ...(paragraph ? { paragraph } : {}) } }
      : {}),
    ...(passageUrl ? { passageUrl } : {}),
    ...(byline ? { byline } : {}),
  };
}

/** Return one sentence around the actual caret; never expand to the whole page. */
export function sentenceAt(text: string, offset: number): string {
  return sentenceSpan(text, offset).text;
}

function sentenceSpan(text: string, offset: number): TextSpan {
  const cursor = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const leftBoundary = Math.max(
    before.lastIndexOf('\n'),
    ...Array.from(before.matchAll(/[.!?](?:\s|$)/gu), (match) => (match.index ?? 0) + 1),
  );
  const rightMatch = /[.!?](?=\s|$)|\n/u.exec(after);
  const rightBoundary = rightMatch
    ? cursor + rightMatch.index + (rightMatch[0] === '\n' ? 0 : 1)
    : text.length;
  return boundedSpan(text, leftBoundary < 0 ? 0 : leftBoundary, rightBoundary, 1_600);
}

function textCandidate(
  document: Document,
  point: ViewportPoint,
  target: Element,
  pageUrl: string,
): ExtractedCandidate | null {
  const extended = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = extended.caretPositionFromPoint?.(point.x, point.y);
  const range = position ? null : extended.caretRangeFromPoint?.(point.x, point.y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  const map = blockText(document, target, node ?? null);
  if (!map) return null;
  const piece = map.pieces.find((entry) => entry.node === node);
  // A paragraph window starts and ends on whole nodes, so a piece is its whole node.
  if (node && (!piece || !Number.isInteger(offset) || offset < 0 || offset > piece.node.length))
    return null;
  const span = piece
    ? sentenceSpan(map.text, piece.start + offset)
    : boundedSpan(map.text, 0, map.text.length, 1_600);
  const evidence = mappedRange(document, map, span);
  if (!evidence || span.text.length < 3) return null;
  return {
    candidate: {
      kind: 'text',
      url: pageUrl,
      title: cleanText(document.title || span.text, 300),
      text: span.text,
      ...passageDetails(document, pageUrl, evidence, span.text),
    },
    target,
    ...textGeometry(document, target, evidence),
  };
}

/** Whether an element draws anything of its own at the point: a fill, a shadow, a blur, text, media or a field. */
function paints(element: Element, document: Document): boolean {
  const window = document.defaultView;
  const style = window?.getComputedStyle(element);
  if (!style || isEditable(element) || PAINTING_TAGS.has(element.tagName.toLowerCase()))
    return true;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;
  const fill = (value: string): boolean =>
    value !== '' && value !== 'transparent' && rgba(value)?.[3] !== 0;
  const drawn = (value: string | undefined): boolean => !!value && value !== 'none';
  if (
    fill(style.backgroundColor) ||
    drawn(style.backgroundImage) ||
    drawn(style.boxShadow) ||
    drawn(style.backdropFilter)
  )
    return true;
  for (const pseudo of ['::before', '::after']) {
    const content = window?.getComputedStyle(element, pseudo).content ?? '';
    if (content && content !== 'none' && content !== 'normal') return true;
  }
  return Array.from(element.childNodes).some(
    (child) => child.nodeType === 3 && child.textContent?.trim(),
  );
}

/**
 * The image under layers the page hides from readers and lays over it, such
 * as the transparent `aria-hidden` lightbox link news sites put across every
 * photo, where the hidden layer alone would capture nothing. Only through
 * layers that draw nothing, never through the hand's own, and never into an
 * image the page hides. A link anyone can follow stays the link.
 */
function imageBeneath(document: Document, point: ViewportPoint): Element | null {
  const stack = document.elementsFromPoint?.(point.x, point.y) ?? [];
  for (const element of stack.slice(0, MAX_OVERLAYS + 1)) {
    if (element.tagName === 'IMG') return hiddenByPage(element, document) ? null : element;
    if (
      !element.closest('[aria-hidden="true"]') ||
      element.closest('[data-zombie-hand-ui]') ||
      paints(element, document)
    )
      return null;
  }
  return null;
}

export function extractCandidate(
  document: Document,
  point: ViewportPoint,
  options: ExtractionOptions = {},
): ExtractedCandidate | null {
  const pageUrl = publicWebUrl(document.location.href, document.location.href);
  if (!pageUrl || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  // An explicit selection does not depend on where the pointer happens to rest.
  if (options.preferSelection) {
    const selected = selectionCandidate(document, point, true, pageUrl);
    if (selected) return selected;
  }
  const hit = document.elementFromPoint(point.x, point.y);
  const target = (hit && !hit.closest('img') && imageBeneath(document, point)) || hit;
  if (!target || isEditable(target) || target.closest(OMITTED_SELECTOR)) return null;
  // A control's own text is never evidence, but a video's transcript cue is a
  // control that seeks the video, and only a site's own reader may take it.
  if (target.closest(CONTROL_SELECTOR)) {
    const special = options.special?.(document, target);
    return special
      ? { candidate: special, rectangle: targetRectangle(target, document), target }
      : null;
  }
  const selected = options.preferSelection
    ? null
    : selectionCandidate(document, point, false, pageUrl);
  if (selected) return selected;
  const rectangle = targetRectangle(target, document);
  const special = options.special?.(document, target);
  if (special) return { candidate: special, rectangle, target };

  const image = target.closest('img');
  if (image) {
    const imageUrl = publicWebUrl(image.currentSrc || image.src, pageUrl);
    if (!imageUrl) return null;
    const alt = cleanText(image.alt, 1_000);
    const caption = cleanText(
      image.closest('figure')?.querySelector('figcaption')?.textContent ?? '',
      1_000,
    );
    return {
      candidate: {
        kind: 'image',
        url: pageUrl,
        title: cleanText(alt || caption || document.title || 'Image', 300),
        text: cleanText([alt, caption].filter(Boolean).join(' — '), 2_000),
        image: { url: imageUrl, alt, rect: targetRectangle(image, document) },
      },
      rectangle: targetRectangle(image, document),
      target: image,
    };
  }

  const anchor = target.closest('a[href]');
  if (anchor) {
    const url = publicWebUrl(anchor.getAttribute('href') ?? '', pageUrl);
    if (!url) return null;
    const text = cleanText(anchor.textContent ?? '', 2_000);
    return {
      candidate: {
        kind: /\.(?:pdf|txt|md|csv|mp3|mp4|webm|wav)(?:$|[?#])/iu.test(url) ? 'file' : 'link',
        url,
        title: cleanText(text || anchor.getAttribute('title') || url, 300),
        text,
      },
      rectangle: targetRectangle(anchor, document),
      target: anchor,
    };
  }

  const block = target.closest(BLOCK_SELECTOR);
  return block ? textCandidate(document, point, block, pageUrl) : null;
}

/** The current explicit page selection, wherever the pointer is. */
export function extractSelection(document: Document): ExtractedCandidate | null {
  const pageUrl = publicWebUrl(document.location.href, document.location.href);
  return pageUrl ? selectionCandidate(document, { x: 0, y: 0 }, true, pageUrl) : null;
}

/**
 * The page itself: its title and link plus a bounded excerpt of visible reading
 * text. Navigation, forms, editable regions and hidden content are skipped.
 */
export function extractPage(document: Document): ExtractedCandidate | null {
  const pageUrl = publicWebUrl(document.location.href, document.location.href);
  const body = document.body;
  if (!pageUrl || !body) return null;
  const title = cleanText(document.title || pageUrl, 300);
  const root = document.querySelector(PAGE_ROOT_SELECTOR) ?? body;
  const skipped =
    root === body ? `${PAGE_CHROME_SELECTOR},${PAGE_BANNER_SELECTOR}` : PAGE_CHROME_SELECTOR;
  const paragraphs: string[] = [];
  let length = 0;
  let truncated = false;
  for (const block of Array.from(root.querySelectorAll(BLOCK_SELECTOR)).slice(0, MAX_PAGE_BLOCKS)) {
    if (block.closest(skipped)) continue;
    const text = cleanText(collectText(document, block)?.text ?? '', MAX_PAGE_EXCERPT);
    if (text.length < 2) continue;
    const separator = paragraphs.length ? 2 : 0;
    const room = MAX_PAGE_EXCERPT - length - separator;
    if (text.length > room) {
      const cut = text.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/u, '');
      if (cut) paragraphs.push(`${cut}…`);
      else if (paragraphs.length) paragraphs.push(`${paragraphs.pop()}…`);
      truncated = true;
      break;
    }
    paragraphs.push(text);
    length += separator + text.length;
  }
  const window = document.defaultView;
  const width = window?.innerWidth ?? document.documentElement.clientWidth;
  const height = window?.innerHeight ?? document.documentElement.clientHeight;
  const byline = pageByline(document);
  return {
    candidate: {
      kind: 'link',
      url: pageUrl,
      title,
      text: paragraphs.join('\n\n') || title,
      ...(byline ? { byline } : {}),
      ...(truncated ? { truncated: true as const } : {}),
    },
    target: body,
    rectangle: { x: 0, y: 0, width, height, viewportWidth: width, viewportHeight: height },
  };
}

/** The type face, size and colours a grabbed copy (and the hand's scale) borrow from its source. */
export function readingStyle(
  element: Element,
  document: Document,
): { fontFamily: string; color: string; background: string; fontSize: number } | undefined {
  const window = document.defaultView;
  if (!window) return undefined;
  const style = window.getComputedStyle(element);
  // A translucent tint (a callout, a hover wash) is mixed over whatever lies
  // beneath it, so the patches and the paper copy come out solid.
  const tints: [number, number, number, number][] = [];
  let background = '';
  for (
    let current: Element | null = element;
    current && !background;
    current = current.parentElement
  ) {
    const value = window.getComputedStyle(current).backgroundColor;
    const colour = rgba(value);
    if (!colour) {
      if (value && value !== 'transparent') background = value;
    } else if (colour[3] >= 1) background = value;
    else if (colour[3] > 0) tints.push(colour);
  }
  if (tints.length && (!background || rgba(background))) {
    const [red, green, blue] = tints.reduceRight<[number, number, number]>(
      (under, [r, g, b, a]) => [
        r * a + under[0] * (1 - a),
        g * a + under[1] * (1 - a),
        b * a + under[2] * (1 - a),
      ],
      (rgba(background) ?? [255, 255, 255]).slice(0, 3) as [number, number, number],
    );
    background = `rgb(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)})`;
  }
  const fontSize = Number.parseFloat(style.fontSize);
  return {
    fontFamily: style.fontFamily,
    color: style.color,
    background: background || 'rgb(255, 255, 255)',
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16,
  };
}

/** A computed `rgb()`/`rgba()` colour as [r, g, b, alpha]; null for any other form. */
function rgba(value: string | undefined): [number, number, number, number] | null {
  const match = /^rgba?\(([^)]*)\)$/u.exec(value?.trim() ?? '');
  const parts =
    match?.[1]
      ?.split(/[\s,/]+/u)
      .filter(Boolean)
      .map(Number) ?? [];
  if (parts.length < 3 || parts.length > 4 || !parts.every(Number.isFinite)) return null;
  const [red = 0, green = 0, blue = 0, alpha = 1] = parts;
  return [red, green, blue, alpha];
}
