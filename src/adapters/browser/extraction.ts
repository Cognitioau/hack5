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
  target: Element;
}

export interface ExtractionOptions {
  preferSelection?: boolean;
  special?: (document: Document, target: Element) => CaptureCandidate | null;
}

const BLOCK_SELECTOR = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,figcaption,td,pre';
const EDITABLE_SELECTOR =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]';
const MAX_TEXT = 12_000;

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
    isEditable(selection.anchorNode?.parentElement ?? null) ||
    isEditable(selection.focusNode?.parentElement ?? null)
  )
    return null;
  const boxes =
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  if (
    !preferSelection &&
    !boxes.some(
      (box) =>
        point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom,
    )
  )
    return null;
  const text = cleanText(selection.toString());
  if (text.length < 2) return null;
  const box =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : target.getBoundingClientRect();
  return {
    candidate: { kind: 'text', url: pageUrl, title: cleanText(document.title || text, 300), text },
    target,
    rectangle: {
      ...targetRectangle(target, document),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    },
  };
}

/** Return one sentence around the actual caret; never expand to the whole page. */
export function sentenceAt(text: string, offset: number): string {
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
  return cleanText(text.slice(leftBoundary < 0 ? 0 : leftBoundary, rightBoundary), 1_600);
}

function caretSentence(document: Document, point: ViewportPoint, target: Element): string | null {
  const extended = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = extended.caretPositionFromPoint?.(point.x, point.y);
  const range = position ? null : extended.caretRangeFromPoint?.(point.x, point.y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  if (node?.nodeType !== 3 || !target.contains(node) || isEditable(node.parentElement)) return null;
  return sentenceAt(node.textContent ?? '', offset) || null;
}

export function extractCandidate(
  document: Document,
  point: ViewportPoint,
  options: ExtractionOptions = {},
): ExtractedCandidate | null {
  const pageUrl = publicWebUrl(document.location.href, document.location.href);
  if (!pageUrl || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const target = document.elementFromPoint(point.x, point.y);
  if (!target || isEditable(target) || target.closest('[data-zombie-hand-ui]')) return null;
  const selected = selectionCandidate(document, point, options.preferSelection ?? false, pageUrl);
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

  const block = target.closest(BLOCK_SELECTOR) ?? target;
  if (
    ['HTML', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'NAV'].includes(block.tagName) ||
    block.closest('button,[role="button"]')
  )
    return null;
  const text = caretSentence(document, point, block) ?? cleanText(block.textContent ?? '', 1_600);
  if (text.length < 3) return null;
  return {
    candidate: { kind: 'text', url: pageUrl, title: cleanText(document.title || text, 300), text },
    rectangle: targetRectangle(block, document),
    target: block,
  };
}
