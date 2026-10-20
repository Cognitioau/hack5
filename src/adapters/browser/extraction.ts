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

/** A bounded, visible text map preserves offsets across inline formatting. */
function collectText(document: Document, target: Element, within?: Range): TextMap | null {
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
    visited += 1;
    if (visited > MAX_SOURCE_NODES || text.length > MAX_SOURCE_TEXT) {
      invalid = true;
      return;
    }
    if (within && !within.intersectsNode(node)) return;
    if (node.nodeType === 3) {
      const value = node as Text;
      const start = within?.startContainer === node ? within.startOffset : 0;
      const end = within?.endContainer === node ? within.endOffset : value.length;
      const part = value.data.slice(start, end);
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
  return {
    candidate: {
      kind: 'text',
      url: pageUrl,
      title: cleanText(document.title || span.text, 300),
      text: span.text,
    },
    target,
    ...textGeometry(document, target, selectedRange),
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
  const map = collectText(document, target);
  if (!map) return null;
  const piece = map.pieces.find((entry) => entry.node === node);
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
    },
    target,
    ...textGeometry(document, target, evidence),
  };
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
  const target = document.elementFromPoint(point.x, point.y);
  if (
    !target ||
    isEditable(target) ||
    target.closest(CONTROL_SELECTOR) ||
    target.closest(OMITTED_SELECTOR)
  )
    return null;
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
      break;
    }
    paragraphs.push(text);
    length += separator + text.length;
  }
  const window = document.defaultView;
  const width = window?.innerWidth ?? document.documentElement.clientWidth;
  const height = window?.innerHeight ?? document.documentElement.clientHeight;
  return {
    candidate: { kind: 'link', url: pageUrl, title, text: paragraphs.join('\n\n') || title },
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
  let background = '';
  for (
    let current: Element | null = element;
    current && !background;
    current = current.parentElement
  ) {
    const value = window.getComputedStyle(current).backgroundColor;
    if (value && value !== 'transparent' && !/^rgba\(.*,\s*0\s*\)$/u.test(value))
      background = value;
  }
  const fontSize = Number.parseFloat(style.fontSize);
  return {
    fontFamily: style.fontFamily,
    color: style.color,
    background: background || 'rgb(255, 255, 255)',
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16,
  };
}
