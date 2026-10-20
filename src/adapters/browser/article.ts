import Defuddle from 'defuddle';
import type { CaptureCandidate } from '../../core/contracts/index';
import { cleanText } from './extraction';

export const MAX_ARTICLE_TEXT = 32_000;
/** Below this the reader is assumed to have missed the article, and the page excerpt is kept. */
const MIN_ARTICLE_TEXT = 200;
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);
const SKIPPED_TAGS = new Set([
  'button',
  'img',
  'math',
  'noscript',
  'script',
  'style',
  'svg',
  'template',
]);
const INLINE_TAGS = new Set(['a', 'b', 'em', 'font', 'i', 'mark', 'small', 'span', 'strong', 'u']);
const UNSEEN_SELECTOR =
  'script,style,noscript,template,iframe,object,embed,[hidden],[aria-hidden="true"],[data-zombie-hand-ui]';

export type Article = Pick<CaptureCandidate, 'title' | 'text' | 'byline' | 'truncated'>;

function unseen(element: Element): boolean {
  if (element.matches(UNSEEN_SELECTOR)) return true;
  const visible = (
    element as Element & {
      checkVisibility?: (options: {
        checkOpacity: boolean;
        checkVisibilityCSS: boolean;
      }) => boolean;
    }
  ).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true });
  if (visible !== false) return false;
  // `display: contents` has no box of its own, yet its children still show.
  return element.ownerDocument.defaultView?.getComputedStyle(element).display !== 'contents';
}

/**
 * A copy of the page without what its reader cannot see, so hidden text never
 * becomes evidence. The live page is never changed.
 */
function visibleCopy(document: Document): Document {
  const copy = document.cloneNode(true) as Document;
  const live = document.body ? Array.from(document.body.getElementsByTagName('*')) : [];
  const copied = copy.body ? Array.from(copy.body.getElementsByTagName('*')) : [];
  if (live.length !== copied.length) return copy;
  const removed: Element[] = [];
  let hiddenRoot: Element | null = null;
  for (const [index, element] of live.entries()) {
    if (hiddenRoot?.contains(element)) continue;
    hiddenRoot = null;
    if (!unseen(element)) continue;
    hiddenRoot = element;
    const twin = copied[index];
    if (twin) removed.push(twin);
  }
  for (const element of removed) element.remove();
  // The reader drops empty inline elements, and with them the only space
  // between two words, as in `stopped<strong> </strong>all`.
  for (const element of copied)
    if (
      element.isConnected &&
      INLINE_TAGS.has(element.tagName.toLowerCase()) &&
      !element.firstElementChild &&
      element.textContent &&
      !element.textContent.trim()
    )
      element.replaceWith(copy.createTextNode(' '));
  return copy;
}

/**
 * The reader's cleaned HTML as plain text that keeps its shape: headings as
 * `#` lines, list items as `-` lines, quotations as `>` lines. Parsed in an
 * inert document, so nothing in it runs or loads.
 */
export function articleText(html: string, maximum: number): { text: string; truncated: boolean } {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const lines: { text: string; item: boolean }[] = [];
  let line = '';
  let marker = '';
  const flush = (): void => {
    const text = line.replace(/\s+/gu, ' ').trim();
    if (text) lines.push({ text: `${marker}${text}`, item: marker.endsWith('- ') });
    if (text) marker = '';
    line = '';
  };
  const visit = (node: Node, quote: string): void => {
    if (node.nodeType === 3) {
      line += (node as Text).data;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'br' || tag === 'hr') {
      flush();
      return;
    }
    if (SKIPPED_TAGS.has(tag)) return;
    // Footnote markers would run into the word before them: "octopodes1".
    if (
      tag === 'sup' &&
      (element.id.startsWith('fnref') || element.querySelector('a[href^="#fn"]'))
    )
      return;
    const block = BLOCK_TAGS.has(tag);
    if (block) {
      flush();
      const heading = /^h([1-6])$/u.exec(tag)?.[1];
      // A paragraph inside a list item keeps the item's dash.
      if (!marker || heading)
        marker = `${quote}${heading ? `${'#'.repeat(Number(heading))} ` : tag === 'li' ? '- ' : ''}`;
    }
    const inner = tag === 'blockquote' ? `${quote}> ` : quote;
    for (const child of element.childNodes) visit(child, inner);
    if (block) {
      flush();
      marker = '';
    }
  };
  visit(body, '');
  flush();
  let text = '';
  for (const [index, entry] of lines.entries()) {
    const separator = index === 0 ? '' : entry.item && lines[index - 1]?.item ? '\n' : '\n\n';
    if (text.length + separator.length + entry.text.length > maximum) {
      const room = maximum - text.length - separator.length - 1;
      const cut = room > 0 ? entry.text.slice(0, room).replace(/\s+\S*$/u, '') : '';
      return { text: cut ? `${text}${separator}${cut}…` : `${text}…`, truncated: true };
    }
    text += separator + entry.text;
  }
  return { text, truncated: false };
}

function isoDate(value: string): string {
  const date = Date.parse(value);
  return Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : '';
}

/**
 * The page's readable article and who wrote it, as Obsidian's own Web Clipper
 * reads it. Returns null when the reader finds too little, so the caller keeps
 * its own excerpt. Runs only on a whole-page grab, in the page's isolated world.
 */
export function readArticle(document: Document, maximum = MAX_ARTICLE_TEXT): Article | null {
  const parsed = new Defuddle(visibleCopy(document), {
    url: document.location.href,
    useAsync: false,
    removeImages: true,
  }).parse();
  const { text, truncated } = articleText(parsed.content ?? '', maximum);
  if (text.length < MIN_ARTICLE_TEXT) return null;
  const author = cleanText(parsed.author ?? '', 200);
  const site = cleanText(parsed.site ?? '', 200);
  const published = isoDate(parsed.published ?? '');
  const byline = {
    ...(author && !/^https?:/iu.test(author) ? { author } : {}),
    ...(site ? { site } : {}),
    ...(published ? { published } : {}),
  };
  const title = cleanText(parsed.title ?? '', 300);
  return {
    title: title || cleanText(document.title || document.location.href, 300),
    text,
    ...(Object.keys(byline).length ? { byline } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}
