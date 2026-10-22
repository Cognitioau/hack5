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
  /** Whether pictures may be taken; without them a lasso centred on one reads the text round it. */
  images?: boolean;
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
/** How far beside the lines of text set in plain `div`s the pointer may rest and still take them, in pixels. */
const MAX_LOOSE_REACH = 16;
/**
 * Displays that keep an element in the line around it, in text set in plain
 * `div`s and `span`s. An `inline-block` or `inline-flex` box, as a chip or a
 * card is, is laid out on its own there.
 */
const LOOSE_INLINE_DISPLAY = /^(?:inline|contents|none|ruby(?:-base|-text)?)$/u;
/**
 * Elements that draw at the pointer whatever their style: media and frames.
 * Fields are editable, SVG and MathML draw by their namespace, and an image
 * ends the lookup.
 */
const PAINTING_TAGS = new Set(['audio', 'canvas', 'embed', 'iframe', 'object', 'video']);
/**
 * Displays that lay an element out as a block of its own, as text fragments
 * count them: words either side of one never run together.
 */
const BLOCK_DISPLAY = /^(?:block|flow-root|flex|grid|table|list-item)$/u;
/** What a closed `details` folds away: everything but its summary. */
const FOLDED_SELECTOR = 'details:not([open]) > :not(summary)';
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const PARAGRAPH_SELECTOR = 'p,li,blockquote,dd,td,pre,figcaption';
const MAX_CONTEXT_PARAGRAPH = 1_500;
/** Headings looked at above a passage, nearest first, past page furniture and hidden ones. */
const MAX_HEADINGS = 200;
const MAX_LINKED_DATA = 200_000;
/** How far apart a lasso looks for text inside its loop, across and down, in pixels. */
const LASSO_COLUMN = 32;
const LASSO_ROW = 10;
/** Pictures are larger than words, so a loop looks for them more sparsely. */
const LASSO_IMAGE_STEP = 24;
const MAX_LASSO_LOOKS = 4_000;
const MAX_LASSO_PASSAGES = 120;
/** The most words a block may have for a loop to take it whole by its lines' starts. */
const MAX_LASSO_ITEM_WORDS = 400;
/** A loop less tall than this many of a block's words is drawn round one of its sentences. */
const LASSO_SENTENCE_LINES = 7;

/** Candidates read from a live selection, which a lasso centred on it takes as they are. */
const fromSelection = new WeakSet<ExtractedCandidate>();
/** The words a sentence candidate was read from, which a lasso centred on them always keeps. */
const evidenceOf = new WeakMap<ExtractedCandidate, Range>();

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

/** Clipped to a pixel or less, as `sr-only` and `visually-hidden` classes keep text for screen readers alone. */
function clippedAway(style: CSSStyleDeclaration): boolean {
  return (
    (style.position === 'absolute' || style.position === 'fixed') &&
    Number.parseFloat(style.width) <= 1 &&
    Number.parseFloat(style.height) <= 1 &&
    (style.overflow !== 'visible' || style.clip !== 'auto' || style.clipPath !== 'none')
  );
}

function hiddenByPage(element: Element, document: Document): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = document.defaultView?.getComputedStyle(current);
    if (
      current.matches(OMITTED_SELECTOR) ||
      current.matches(FOLDED_SELECTOR) ||
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0' ||
      (style && clippedAway(style))
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
  /**
   * `beside` when the parent lays its children out side by side, as a flex
   * row or a grid does; `atomic` inside an inline box such as an
   * `inline-flex` link or an `inline-block` formula.
   */
  const visit = (node: Node, beside = false, atomic = false): void => {
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
      style?.opacity === '0' ||
      (style && clippedAway(style)) ||
      // A closed `details` shows only its summary, which is a control.
      (element.tagName === 'DETAILS' && !element.hasAttribute('open'))
    ) {
      boundary();
      return;
    }
    const nestedBlock = element !== target && element.matches(BLOCK_SELECTOR);
    const display = style?.display ?? '';
    // Rows laid out as blocks, as `div`s in a list item are, read as lines of
    // their own. Chrome also reports a float, a positioned box, a flex row's
    // or a grid's items and a block inside an inline box as blocks, but each
    // sits within its line, so it reads within it.
    const laidOut =
      element !== target &&
      !nestedBlock &&
      !beside &&
      !atomic &&
      BLOCK_DISPLAY.test(display) &&
      !/^(?:left|right|inline-start|inline-end)$/u.test(style?.getPropertyValue('float') ?? '') &&
      !/^(?:absolute|fixed)$/u.test(style?.position ?? '');
    if (element.tagName === 'BR' || nestedBlock || laidOut) boundary();
    // The normal path captures a sentence in one semantic block. Only explicit
    // selection is allowed to collect multiple blocks.
    if (nestedBlock && !within) return;
    const sideBySide =
      display === 'contents'
        ? beside
        : /^(?:inline-)?grid$/u.test(display) ||
          (/^(?:inline-)?flex$/u.test(display) &&
            !(style?.flexDirection ?? '').startsWith('column'));
    const inline = atomic || (element !== target && display.startsWith('inline-'));
    for (const child of element.childNodes) visit(child, sideBySide, inline);
    if (nestedBlock || laidOut) boundary();
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
 * than its paragraph. Null when the node is not text inside the block. In
 * loose text, an inline box of its own also ends the paragraph.
 */
function paragraphWindow(block: Element, anchor: Node, loose = false): Set<Node> | null {
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
        !(loose ? LOOSE_INLINE_DISPLAY : /^(?:inline|contents|none|ruby)/u).test(
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

/** A paragraph window without the text in `skip`, read already, so two windows never share a line. */
function unread(window: Set<Node>, skip?: ReadonlySet<Node>): Set<Node> {
  if (skip)
    for (const node of window) if (node.nodeType === 3 && skip.has(node)) window.delete(node);
  return window;
}

/**
 * The text of a block, or of the paragraph around a node when the block is
 * too large, less any of it in `skip`.
 */
function blockText(
  document: Document,
  block: Element,
  anchor: Node | null,
  skip?: ReadonlySet<Node>,
): TextMap | null {
  const whole = collectText(document, block);
  if (whole || !anchor || !block.contains(anchor)) return whole;
  const window = paragraphWindow(block, anchor);
  return window ? collectText(document, block, undefined, unread(window, skip)) : null;
}

/**
 * The paragraph around a node in text a page sets in plain `div`s and `span`s,
 * as search results and many apps do: the run of text ending at anything laid
 * out as a block, never the block whole, which may hold many such lines.
 */
function looseText(
  document: Document,
  block: Element,
  anchor: Node | null,
  skip?: ReadonlySet<Node>,
): TextMap | null {
  const window = anchor && paragraphWindow(block, anchor, true);
  return window ? collectText(document, block, undefined, unread(window, skip)) : null;
}

/** The nearest element holding the target that is laid out on its own, short of the page itself. */
function laidOutBlock(document: Document, target: Element): Element | null {
  for (
    let at: Element | null = target;
    at && at !== document.body && at !== document.documentElement;
    at = at.parentElement
  )
    if (!LOOSE_INLINE_DISPLAY.test(document.defaultView?.getComputedStyle(at).display ?? 'inline'))
      return at;
  return null;
}

/** Whether the pointer rests on or just beside any of a range's line boxes. */
function beside(range: Range, point: ViewportPoint): boolean {
  const boxes =
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  return boxes.some(
    (box) =>
      box.width > 0 &&
      box.height > 0 &&
      point.x >= box.left - MAX_LOOSE_REACH &&
      point.x <= box.right + MAX_LOOSE_REACH &&
      point.y >= box.top - MAX_LOOSE_REACH &&
      point.y <= box.bottom + MAX_LOOSE_REACH,
  );
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
  const candidate: ExtractedCandidate = {
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
  fromSelection.add(candidate);
  return candidate;
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
 * whole passage when short, otherwise its first and last four words. A passage
 * running over several blocks, which a fragment cannot match in one piece,
 * starts with the first block's opening words and ends with the last's closing
 * words, given as `ending`.
 */
export function passageLink(
  pageUrl: string,
  evidence: string,
  ending?: string,
): string | undefined {
  const wordsOf = (value: string): string[] =>
    value.replace(/…$/u, '').split(/\s+/u).filter(Boolean);
  const words = wordsOf(evidence);
  const last = ending === undefined ? words : wordsOf(ending);
  if (!words.length || !last.length) return undefined;
  // Dashes and commas are text-directive syntax, so they are escaped too.
  const encode = (part: string[]): string =>
    encodeURIComponent(part.join(' ')).replace(/-/gu, '%2D');
  const directive =
    ending === undefined && words.length <= 8
      ? encode(words)
      : `${encode(words.slice(0, 4))},${encode(last.slice(-4))}`;
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

/**
 * What a grabbed passage needs to stand on its own in the vault. A passage
 * over several blocks links back by `ends`: its first block's text and its
 * last's, as a text fragment matches each within one block.
 */
function passageDetails(
  document: Document,
  pageUrl: string,
  range: Range,
  evidence: string,
  ends?: readonly [string, string],
): PassageDetails {
  const heading = headingBefore(document, range.startContainer);
  const paragraph = paragraphAround(document, range, evidence);
  const passageUrl = ends ? passageLink(pageUrl, ends[0], ends[1]) : passageLink(pageUrl, evidence);
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
  loose = false,
): ExtractedCandidate | null {
  const extended = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = extended.caretPositionFromPoint?.(point.x, point.y);
  const range = position ? null : extended.caretRangeFromPoint?.(point.x, point.y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset ?? 0;
  const map = (loose ? looseText : blockText)(document, target, node ?? null);
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
  // Over blank space Chrome puts its caret in the nearest words, however far
  // off, so loose text is taken only beside them; checked before the details
  // are read, as this runs on every move of an aimed lasso.
  if (loose && !beside(evidence, point)) return null;
  const candidate: ExtractedCandidate = {
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
  evidenceOf.set(candidate, evidence);
  return candidate;
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
  if (block) return textCandidate(document, point, block, pageUrl);
  // Text set in plain `div`s and `span`s, as search results are, is read only
  // when the caret lies in it and the pointer on or beside its lines.
  const loose = laidOutBlock(document, target);
  return loose ? textCandidate(document, point, loose, pageUrl, true) : null;
}

/** The current explicit page selection, wherever the pointer is. */
export function extractSelection(document: Document): ExtractedCandidate | null {
  const pageUrl = publicWebUrl(document.location.href, document.location.href);
  return pageUrl ? selectionCandidate(document, { x: 0, y: 0 }, true, pageUrl) : null;
}

/** Positive when the path a → b → c turns one way, negative the other, zero when straight. */
const turn = (a: ViewportPoint, b: ViewportPoint, c: ViewportPoint): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/**
 * The convex outline of a lasso's loop: everything the loop goes round, so a
 * loop left a little open, or begun from its middle, still holds what it
 * circles. Empty when the points enclose nothing.
 */
export function loopOutline(points: readonly ViewportPoint[]): ViewportPoint[] {
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(({ x, y }) => ({ x, y }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  // Andrew's monotone chain: each half keeps only points where the path turns the same way.
  const bends = (kept: ViewportPoint[], point: ViewportPoint): boolean => {
    const last = kept.at(-1);
    const before = kept.at(-2);
    return !!last && !!before && turn(before, last, point) <= 0;
  };
  const half = (ordered: readonly ViewportPoint[]): ViewportPoint[] => {
    const kept: ViewportPoint[] = [];
    for (const point of ordered) {
      while (bends(kept, point)) kept.pop();
      kept.push(point);
    }
    return kept.slice(0, -1);
  };
  const outline = [...half(sorted), ...half([...sorted].reverse())];
  return outline.length >= 3 ? outline : [];
}

/** Whether a point lies inside a loop's outline, or on it. */
export function insideOutline(outline: readonly ViewportPoint[], point: ViewportPoint): boolean {
  return (
    outline.length >= 3 &&
    outline.every(
      (corner, index) => turn(corner, outline[(index + 1) % outline.length] ?? corner, point) >= 0,
    )
  );
}

/** Where a loop's outline crosses a row of the page, left to right; null when it misses the row. */
function outlineRow(outline: readonly ViewportPoint[], y: number): [number, number] | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  outline.forEach((a, index) => {
    const b = outline[(index + 1) % outline.length] ?? a;
    if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) return;
    const xs = a.y === b.y ? [a.x, b.x] : [a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)];
    from = Math.min(from, ...xs);
    to = Math.max(to, ...xs);
  });
  return from <= to ? [from, to] : null;
}

/** A word's box on screen. */
type WordBox = Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>;

/**
 * Whether a loop holds a word, for the sentence it is in. A loop drawn round
 * a sentence holds it inside its rim; any other loop clear of the rim by half
 * the word's height, so a rim passing over a line holds none of that line.
 */
export function holdsWord(
  outline: readonly ViewportPoint[],
  word: WordBox,
  precise: boolean,
): boolean {
  const clear = precise ? 0 : (word.bottom - word.top) / 2;
  return [
    { x: word.left - clear, y: word.top - clear },
    { x: word.right + clear, y: word.top - clear },
    { x: word.left - clear, y: word.bottom + clear },
    { x: word.right + clear, y: word.bottom + clear },
  ].every((corner) => insideOutline(outline, corner));
}

/**
 * How many of a sentence's words a loop must hold to take it: every one for
 * a loop drawn round a sentence, else a quarter of them, two at least.
 */
export function wordsToTake(total: number, precise: boolean): number {
  return precise ? total : Math.min(total, Math.max(2, Math.ceil(total / 4)));
}

/**
 * Whether a loop holds the start of a line, given its first word: across the
 * word's top, middle and bottom the loop reaches back into it, or two lines'
 * height into a short one, as an oval cutting a column's corners still does
 * and one whose tip only crosses the line does not.
 */
export function holdsLineStart(outline: readonly ViewportPoint[], first: WordBox): boolean {
  const height = first.bottom - first.top;
  const reach = first.left + Math.max(first.right - first.left, height * 2);
  return [first.top, first.top + height / 2, first.bottom].every((y) => {
    const row = outlineRow(outline, y);
    return row !== null && row[0] <= reach && row[1] >= first.left;
  });
}

/**
 * The sentences of a text, as spans, ending where sentenceAt ends one: after
 * a full stop, question or exclamation mark followed by a space, or at a line
 * break. Every word lies in exactly one.
 */
export function sentenceSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?](?=\s|$)|\n/gu)) {
    const at = match.index ?? 0;
    const end = match[0] === '\n' ? at : at + 1;
    if (text.slice(start, end).trim()) spans.push({ start, end });
    start = at + 1;
  }
  if (text.slice(start).trim()) spans.push({ start, end: text.length });
  return spans;
}

interface LassoPassage {
  map: TextMap;
  block: Element;
  /** Where the passage starts and ends in its block's text, on whole sentences. */
  start: number;
  end: number;
  /** Whether it holds more than the sentence the loop is centred on. */
  more: boolean;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/**
 * The text a node is read with, as the sentence under the pointer would be:
 * its block's, or for text set in plain `div`s the paragraph around it. Null
 * for text the pointer never takes: hidden, editable, a control's, the hand's.
 * Text in `skip`, read already, is left out of a large block's paragraph.
 */
function passageAround(
  document: Document,
  node: Text,
  skip?: ReadonlySet<Node>,
): { map: TextMap; block: Element } | null {
  const element = node.parentElement;
  if (
    !element ||
    isEditable(element) ||
    element.closest(CONTROL_SELECTOR) ||
    element.closest(OMITTED_SELECTOR)
  )
    return null;
  const block = element.closest(BLOCK_SELECTOR);
  if (block) {
    const map = blockText(document, block, node, skip);
    return map ? { map, block } : null;
  }
  const loose = laidOutBlock(document, element);
  const map = loose && looseText(document, loose, node, skip);
  return loose && map ? { map, block: loose } : null;
}

/** Where a piece's node offset falls in its block's text. */
function pieceOffset(piece: TextPiece, offset: number): number {
  return piece.start + Math.max(0, Math.min(offset - piece.nodeOffset, piece.end - piece.start));
}

/** The part of the viewport a loop's outline covers. */
function outlineBox(document: Document, outline: readonly ViewportPoint[]) {
  const window = document.defaultView;
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  return {
    left: Math.max(0, Math.min(...xs)),
    top: Math.max(0, Math.min(...ys)),
    right: Math.min(window?.innerWidth ?? document.documentElement.clientWidth, Math.max(...xs)),
    bottom: Math.min(window?.innerHeight ?? document.documentElement.clientHeight, Math.max(...ys)),
  };
}

/** Evenly spaced points inside a loop's outline, row by row, at most `limit` of them. */
function* insidePoints(
  document: Document,
  outline: readonly ViewportPoint[],
  column: number,
  row: number,
  limit: number,
): Generator<ViewportPoint> {
  const box = outlineBox(document, outline);
  let looked = 0;
  for (let y = box.top + row / 2; y < box.bottom; y += row) {
    const span = outlineRow(outline, y);
    if (!span) continue;
    const from = Math.max(box.left, span[0]);
    const to = Math.min(box.right, span[1]);
    if (to <= from) continue;
    const count = Math.max(1, Math.ceil((to - from) / column));
    for (let index = 0; index < count; index++) {
      if (looked++ >= limit) return;
      yield { x: from + ((to - from) * (index + 0.5)) / count, y };
    }
  }
}

/**
 * The passages a loop holds, in page order, and whether it reached text past
 * the most blocks it reads. In each block it reaches: every sentence it holds
 * a quarter of the words of, two at least, and the sentences of what it is
 * centred on (a sentence, or a link's text); first to last, so nothing between
 * them drops out. A loop that takes from more than one block, as one drawn
 * down a list's steps does, takes whole each block whose every line it holds
 * the start of. A block it holds words of only on one line, in the top or
 * bottom quarter of its height and away from its centre, is one its rim
 * crosses: of it, only sentences on lines whose start it holds are taken, so
 * the bulge of an oval drawn round a column, across the middle of the line
 * above or below it, takes nothing. A loop holds a line's start when, along
 * the top, middle and bottom of the line's first word, it reaches back into
 * that word, as an oval cutting a column's corners still does.
 * For a sentence, a word is held only clear of the rim by half its height, so
 * a rim passing over a line takes none of that line. A loop only a few lines
 * of a block's text tall is drawn round a sentence: beyond the one at its
 * centre it takes only sentences it holds whole, and a block whole by its
 * lines' starts only when it encloses most of its words, as a small circle's
 * rim crosses the lines, and the starts of short blocks, above and below its
 * sentence, while a loop round a short list holds most of each item.
 */
function lassoPassages(
  document: Document,
  outline: readonly ViewportPoint[],
  centre: Range | null,
): { passages: LassoPassage[]; cut: boolean } {
  const area = outlineBox(document, outline);
  const highest = Math.min(...outline.map((point) => point.y));
  const lowest = Math.max(...outline.map((point) => point.y));
  const tall = lowest - highest;
  const seen = new Set<Node>();
  let cut = false;
  /** Each block the loop takes from: its sentences, which it holds (alone, and alongside other blocks), and whether it holds every line's start. */
  const blocks: {
    map: TextMap;
    block: Element;
    sentences: { start: number; end: number }[];
    centred: Set<number>;
    taken: Set<number>;
    alongside: Set<number>;
    starts: boolean;
  }[] = [];
  const read = (node: Node | null | undefined): void => {
    if (node?.nodeType !== 3 || seen.has(node)) return;
    // Past the most blocks it reads, a loop reaching more text is cut short.
    const around = cut ? null : passageAround(document, node as Text, seen);
    seen.add(node);
    if (!around) return;
    if (blocks.length >= MAX_LASSO_PASSAGES) {
      cut = true;
      return;
    }
    const { map, block } = around;
    for (const piece of map.pieces) seen.add(piece.node);
    const sentences = sentenceSpans(map.text);
    /** The sentence holding a character: the last starting at or before it. */
    const sentenceOf = (offset: number): number => {
      let low = 0;
      let high = sentences.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((sentences[middle]?.start ?? 0) <= offset) low = middle + 1;
        else high = middle;
      }
      return low - 1;
    };
    const centred = new Set<number>();
    for (const piece of centre ? map.pieces : []) {
      if (!centre?.intersectsNode(piece.node)) continue;
      const from =
        piece.node === centre.startContainer ? pieceOffset(piece, centre.startOffset) : piece.start;
      const to =
        piece.node === centre.endContainer ? pieceOffset(piece, centre.endOffset) : piece.end;
      if (to > from)
        sentences.forEach((sentence, index) => {
          if (sentence.end > from && sentence.start < to) centred.add(index);
        });
    }
    const taken = new Set(centred);
    /** Whether the loop holds more of this block than words along one line at its rim: words in its middle half, or on two lines. */
    let across = centred.size > 0;
    let heldTop = Number.POSITIVE_INFINITY;
    let heldBottom = Number.NEGATIVE_INFINITY;
    /** How many words each sentence has, and how many of them the loop holds. */
    const words = sentences.map(
      (sentence) => map.text.slice(sentence.start, sentence.end).match(/\S+/gu)?.length ?? 0,
    );
    const held = sentences.map(() => 0);
    // A block the size of a list item or paragraph is read line by line, to
    // see whether the loop holds the start of every line.
    const item = words.reduce((sum, count) => sum + count, 0) <= MAX_LASSO_ITEM_WORDS;
    let lines = 0;
    let heldStarts = 0;
    let line: DOMRect | null = null;
    /** Whether the loop holds the start of the line being read, and the sentences on such lines. */
    let lineHeld = false;
    /** For a loop drawn round a sentence, how many of the block's words it encloses, of how many. */
    let enclosed = 0;
    let seenWords = 0;
    const lined = new Set<number>();
    /** Whether the loop is drawn round a sentence of this block's text, judged by its first word. */
    let precise: boolean | null = null;
    const range = document.createRange();
    if (typeof range.getClientRects !== 'function') return;
    for (const piece of map.pieces) {
      range.setStart(piece.node, piece.nodeOffset);
      range.setEnd(piece.node, piece.nodeOffset + piece.end - piece.start);
      const reaches = Array.from(range.getClientRects()).some(
        (box) =>
          box.width > 0 &&
          box.height > 0 &&
          box.right > area.left &&
          box.left < area.right &&
          box.bottom > area.top &&
          box.top < area.bottom,
      );
      if (!reaches && !item) continue;
      for (const word of map.text.slice(piece.start, piece.end).matchAll(/\S+/gu)) {
        const start = piece.start + (word.index ?? 0);
        const index = sentenceOf(start);
        if (index < 0 || (!item && across && taken.has(index))) continue;
        const offset = piece.nodeOffset + start - piece.start;
        range.setStart(piece.node, offset);
        range.setEnd(piece.node, offset + word[0].length);
        const bounds = range.getBoundingClientRect();
        if (!(bounds.width > 0 && bounds.height > 0)) continue;
        // A word half a line below the one before it starts a new line.
        if (!line || bounds.top >= line.top + line.height / 2) {
          lines += 1;
          lineHeld = reaches && holdsLineStart(outline, bounds);
          if (lineHeld) heldStarts += 1;
        }
        line = bounds;
        if (lineHeld) lined.add(index);
        precise ??= tall < LASSO_SENTENCE_LINES * bounds.height;
        if (precise) {
          seenWords += 1;
          if (reaches && holdsWord(outline, bounds, true)) enclosed += 1;
        }
        const settled = taken.has(index);
        if (!reaches || (settled && across) || !holdsWord(outline, bounds, precise)) continue;
        if (!across) {
          heldTop = Math.min(heldTop, bounds.top);
          heldBottom = Math.max(heldBottom, bounds.bottom);
          const middle = (bounds.top + bounds.bottom) / 2;
          across =
            (middle > highest + tall / 4 && middle < lowest - tall / 4) ||
            heldBottom - heldTop > bounds.height * 1.5;
        }
        if (settled) continue;
        const count = (held[index] ?? 0) + 1;
        held[index] = count;
        const total = words[index] ?? 1;
        if (count >= wordsToTake(total, precise)) taken.add(index);
      }
    }
    const starts =
      item && lines > 0 && heldStarts === lines && (!precise || enclosed * 2 > seenWords);
    // Of a block its rim only crosses, a loop takes alongside other blocks
    // only sentences on lines whose start it holds.
    const alongside = across ? taken : new Set([...taken].filter((index) => lined.has(index)));
    if (taken.size || starts)
      blocks.push({ map, block, sentences, centred, taken, alongside, starts });
  };
  if (centre) {
    // The centre's own passages are read first, whatever the loop's looks find.
    const walker = document.createTreeWalker(centre.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    for (
      let node: Node | null = walker.currentNode, looked = 0;
      node && looked < MAX_SOURCE_NODES;
      node = walker.nextNode(), looked++
    )
      if (centre.intersectsNode(node)) read(node);
  }
  const caret = document as CaretDocument;
  for (const { x, y } of insidePoints(
    document,
    outline,
    LASSO_COLUMN,
    LASSO_ROW,
    MAX_LASSO_LOOKS,
  )) {
    const position = caret.caretPositionFromPoint?.(x, y);
    read(position ? position.offsetNode : caret.caretRangeFromPoint?.(x, y)?.startContainer);
  }
  const region = blocks.length > 1;
  const passages: LassoPassage[] = [];
  for (const { map, block, sentences, centred, taken, alongside, starts } of blocks) {
    const chosen = !region ? taken : starts ? new Set(sentences.keys()) : alongside;
    const first = sentences[Math.min(...chosen)];
    const last = sentences[Math.max(...chosen)];
    const more = [...chosen].some((index) => !centred.has(index));
    if (first && last) passages.push({ map, block, start: first.start, end: last.end, more });
  }
  const startOf = (passage: LassoPassage): Node =>
    passage.map.pieces.find((piece) => piece.end > passage.start)?.node ?? passage.block;
  passages.sort((a, b) => {
    const first = startOf(a);
    const second = startOf(b);
    if (first === second) return a.start - b.start;
    return first.compareDocumentPosition(second) & first.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return { passages, cut };
}

/**
 * A point on the largest picture a loop mostly goes round, at least as large
 * as a line of text, for a loop that holds no text.
 */
function lassoImage(document: Document, outline: readonly ViewportPoint[]): ViewportPoint | null {
  const seen = new Set<Element>();
  let best: { point: ViewportPoint; area: number } | null = null;
  for (const point of insidePoints(
    document,
    outline,
    LASSO_IMAGE_STEP,
    LASSO_IMAGE_STEP,
    MAX_LASSO_LOOKS,
  )) {
    const image = imageBeneath(document, point);
    if (!image || seen.has(image)) continue;
    seen.add(image);
    const bounds = image.getBoundingClientRect();
    if (bounds.width < 24 || bounds.height < 24) continue;
    // Mostly inside: over half of a grid laid across it.
    let inside = 0;
    for (let row = 0; row < 5; row++)
      for (let column = 0; column < 5; column++)
        if (
          insideOutline(outline, {
            x: bounds.left + (bounds.width * (column + 0.5)) / 5,
            y: bounds.top + (bounds.height * (row + 0.5)) / 5,
          })
        )
          inside += 1;
    const area = bounds.width * bounds.height;
    if (inside > 12 && (!best || area > best.area)) best = { point, area };
  }
  return best?.point ?? null;
}

/** The most boxes a lasso's highlight is drawn with, as many as the hand draws. */
const MAX_HIGHLIGHT_BOXES = 128;

/**
 * Fragments of one line, such as bold words and links, as one box per line;
 * `across` joins every box of a row, however far apart, as the columns of a
 * table's row.
 */
function lineBoxes(rectangles: readonly TargetRectangle[], across = false): TargetRectangle[] {
  // A raised note can start a line's box away from its first words, so the
  // boxes are joined again until no two of one line are left apart.
  let lines = joinLines(rectangles, across);
  for (let joined = joinLines(lines, across); joined.length < lines.length; ) {
    lines = joined;
    joined = joinLines(lines, across);
  }
  return lines;
}

function joinLines(rectangles: readonly TargetRectangle[], across: boolean): TargetRectangle[] {
  const lines: TargetRectangle[] = [];
  for (const box of [...rectangles].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((other) => {
      const overlap =
        Math.min(other.y + other.height, box.y + box.height) - Math.max(other.y, box.y);
      const shorter = Math.min(other.height, box.height);
      const gap = Math.max(other.x, box.x) - Math.min(other.x + other.width, box.x + box.width);
      return overlap > shorter / 2 && (across || gap <= shorter);
    });
    if (!line) {
      lines.push({ ...box });
      continue;
    }
    const right = Math.max(line.x + line.width, box.x + box.width);
    const bottom = Math.max(line.y + line.height, box.y + box.height);
    line.x = Math.min(line.x, box.x);
    line.y = Math.min(line.y, box.y);
    line.width = right - line.x;
    line.height = bottom - line.y;
  }
  return lines;
}

/**
 * A passage's words in the viewport, as boxes read one text node at a time,
 * so the boxes of the links and notes round them never crowd them out.
 */
function passageBoxes(
  document: Document,
  map: TextMap,
  span: TextSpan,
  fallback: TargetRectangle,
): TargetRectangle[] {
  const boxes: TargetRectangle[] = [];
  const range = document.createRange();
  if (typeof range.getClientRects !== 'function') return boxes;
  for (const piece of map.pieces) {
    if (piece.end <= span.start || piece.start >= span.end) continue;
    range.setStart(piece.node, piece.nodeOffset + Math.max(0, span.start - piece.start));
    range.setEnd(piece.node, piece.nodeOffset + Math.min(piece.end, span.end) - piece.start);
    for (const box of range.getClientRects())
      if (
        [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
        box.width > 0 &&
        box.height > 0 &&
        box.right > 0 &&
        box.bottom > 0 &&
        box.left < fallback.viewportWidth &&
        box.top < fallback.viewportHeight
      )
        boxes.push({ ...fallback, x: box.x, y: box.y, width: box.width, height: box.height });
  }
  return boxes;
}

/**
 * Whether the line break at `index` is one read between blocks, rather than
 * one in the page's own text, as a `pre` keeps.
 */
function betweenBlocks(map: TextMap, index: number): boolean {
  let low = 0;
  let high = map.pieces.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((map.pieces[middle]?.start ?? 0) <= index) low = middle + 1;
    else high = middle;
  }
  const piece = map.pieces[low - 1];
  return !piece || index >= piece.end;
}

/**
 * A passage's first or last run between the line breaks read between blocks,
 * as a text fragment matches each of its ends within one block.
 */
function passageEnd(map: TextMap, span: TextSpan, last: boolean): TextSpan {
  let from = span.start;
  let to = span.end;
  if (last) {
    for (let index = span.end - 1; index >= span.start; index -= 1)
      if (map.text[index] === '\n' && betweenBlocks(map, index)) {
        from = index + 1;
        break;
      }
  } else {
    for (let index = span.start; index < span.end; index += 1)
      if (map.text[index] === '\n' && betweenBlocks(map, index)) {
        to = index;
        break;
      }
  }
  return boundedSpan(map.text, from, to, Number.POSITIVE_INFINITY);
}

/**
 * One text capture of a loop's passages, a blank line between them, as a
 * whole-page excerpt joins its paragraphs; `cut` when the loop reached more
 * than was read.
 */
function lassoCandidate(
  document: Document,
  pageUrl: string,
  passages: readonly LassoPassage[],
  cut = false,
): ExtractedCandidate | null {
  const parts: string[] = [];
  const read: { range: Range; block: Element; map: TextMap; span: TextSpan }[] = [];
  let truncated = cut;
  for (const passage of passages) {
    const room = MAX_TEXT - parts.reduce((sum, part) => sum + part.length + 2, 0);
    const whole = boundedSpan(
      passage.map.text,
      passage.start,
      passage.end,
      Number.POSITIVE_INFINITY,
    );
    const span =
      whole.text.length > room
        ? boundedSpan(passage.map.text, passage.start, passage.end, room)
        : whole;
    const range = span.text.length >= 2 ? mappedRange(document, passage.map, span) : null;
    if (range) {
      parts.push(span.text);
      read.push({ range, block: passage.block, map: passage.map, span });
    }
    if (span !== whole) {
      truncated = true;
      break;
    }
  }
  const first = read[0];
  const last = read.at(-1);
  if (!first || !last) return null;
  const text = parts.join('\n\n');
  const rectangles: TargetRectangle[] = [];
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { range, block, map, span } of read) {
    const fallback = targetRectangle(block, document);
    rectangles.push(...passageBoxes(document, map, span, fallback));
    const bounds = range.getBoundingClientRect();
    const box =
      [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
      bounds.width > 0 &&
      bounds.height > 0
        ? bounds
        : fallback;
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  const whole = document.createRange();
  whole.setStart(first.range.startContainer, first.range.startOffset);
  whole.setEnd(last.range.endContainer, last.range.endOffset);
  // Lines past what the hand draws join into rows, so none drops out of the highlight.
  let lines = lineBoxes(rectangles);
  if (lines.length > MAX_HIGHLIGHT_BOXES) lines = lineBoxes(lines, true);
  lines = lines.slice(0, MAX_HIGHLIGHT_BOXES);
  // One run of text links back as a sentence does; more, by their first and last runs.
  const opening = passageEnd(first.map, first.span, false);
  const closing = passageEnd(last.map, last.span, true);
  const ends: [string, string] | undefined =
    read.length > 1 || opening.start !== first.span.start || opening.end !== last.span.end
      ? [opening.text, closing.text]
      : undefined;
  return {
    candidate: {
      kind: 'text',
      url: pageUrl,
      title: cleanText(document.title || text, 300),
      text,
      ...passageDetails(document, pageUrl, whole, text, ends),
      ...(truncated ? { truncated: true as const } : {}),
    },
    target: first.block,
    rectangle: {
      ...targetRectangle(first.block, document),
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    ...(lines.length ? { rectangles: lines } : {}),
  };
}

/**
 * What a lasso's loop takes. A picture, video or live selection at its centre
 * is taken as itself. Otherwise every sentence with a whole word inside the
 * loop, whole, in page order with a blank line between passages, the sentence
 * at its centre always among them; a loop holding no more than the sentence
 * or link at its centre takes just that, as the pointer would, and one holding
 * no text takes the picture it goes round.
 */
export function extractEnclosed(
  document: Document,
  loop: readonly ViewportPoint[],
  centre: ViewportPoint,
  options: ExtractionOptions = {},
): ExtractedCandidate | null {
  const found = extractCandidate(document, centre, options);
  const pictures = options.images !== false;
  // Without pictures, a loop centred on one reads the text round it.
  const centred = found?.candidate.kind === 'image' && !pictures ? null : found;
  const pageUrl = publicWebUrl(document.location.href, document.location.href);
  const outline = loopOutline(loop);
  if (!pageUrl || !outline.length) return centred;
  if (
    centred &&
    (fromSelection.has(centred) || !['text', 'link', 'file'].includes(centred.candidate.kind))
  )
    return centred;
  let held: Range | null = null;
  if (centred?.candidate.kind === 'text') held = evidenceOf.get(centred) ?? null;
  else if (centred) {
    held = document.createRange();
    held.selectNodeContents(centred.target);
  }
  const { passages, cut } = lassoPassages(document, outline, held);
  if (!passages.length) {
    if (centred || !pictures) return centred;
    const point = lassoImage(document, outline);
    const image = point && extractCandidate(document, point, options);
    return image && image.candidate.kind === 'image' ? image : null;
  }
  if (centred && !cut && passages.every((passage) => !passage.more)) return centred;
  const enclosed = lassoCandidate(document, pageUrl, passages, cut);
  // However its block is read, the sentence at the centre is never lost.
  if (
    centred?.candidate.kind === 'text' &&
    !enclosed?.candidate.text.includes(centred.candidate.text)
  )
    return centred;
  return enclosed ?? centred;
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
