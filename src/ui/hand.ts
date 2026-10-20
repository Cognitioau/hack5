import type { CaptureCandidate, SearchResult } from '../core/contracts/index';
import { GRAVE_DURATION, GraveEffect, type GraveKind, pickHand, type ScrapStyle } from './grave';

type TargetRectangle = NonNullable<CaptureCandidate['image']>['rect'];
type Rectangle = Pick<TargetRectangle, 'x' | 'y' | 'width' | 'height'>;
type Point = Pick<Rectangle, 'x' | 'y'>;

export type HandState = 'idle' | 'arming' | 'armed' | 'saving' | 'saved' | 'archived' | 'error';
export interface HandActions {
  /** Grab the current text selection. */
  capture: () => void;
  cancel: () => void;
  archive: () => void;
  close: () => void;
  page?: () => void;
  /** The primary button: the selection when there is one, otherwise the page. */
  grab?: () => void;
  /** Reads one grave hand's packaged frames; its grave opens without a hand until they arrive. */
  sprite?: (hand: number) => Promise<Uint8Array<ArrayBuffer> | null>;
}
export interface TargetPresentation {
  kind?: GraveKind;
  style?: ScrapStyle;
  /** Page host shown on a page grab's sheet. */
  detail?: string;
  /** Where the page itself highlights the target (a live selection), hidden once the words are taken. */
  highlight?: readonly Rectangle[];
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const HAND_PATH =
  'M8 25 5 20 1.5 15Q.5 13 2 12.5q1-.5 2 1L6 16 4.5 6Q4 3.8 6 3.7q1.5 0 1.8 2L9 12 9 3Q9 .7 11 .8q1.6 0 1.6 2L13 12l1-8q.3-2 2-1.7 1.8.3 1.5 2.2L17 14l2-6q.7-2 2.2-1.4 1.5.6.8 2.5L20 19l-3 6Z';
/** A saved/archived receipt shrinks back to the bare icon after this long. */
const QUIET_AFTER_MS = 6_000;
const STYLE = `
:host{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#f4f4ed!important;--acid:#cff890;--ink:#171d1b;--muted:#b5bfb8}
*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid var(--acid);outline-offset:3px}[hidden]{display:none!important}
.dock{position:fixed;right:14px;bottom:14px;max-width:calc(100vw - 20px);background:var(--ink);border:1px solid #475447;border-radius:21px;box-shadow:0 4px 14px #10201430;color:#f4f4ed;z-index:2147483647;transition:opacity .18s}
.dock[data-expanded="false"][data-state="idle"],.dock[data-expanded="false"][data-quiet="true"]{opacity:.78;border-color:transparent}
.dock[data-expanded="false"][data-state="idle"]:hover,.dock[data-expanded="false"][data-quiet="true"]:hover,.dock:focus-within{opacity:1}
.bar{display:flex;align-items:center;gap:2px;padding:2px}
.grab{position:relative;display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:18px;background:transparent;padding:0;flex:none}.grab:hover{background:#ffffff12}.grab:disabled{cursor:default}
.mark{width:19px;height:21px;fill:#aacc83;stroke:#e0f8c0;stroke-width:1.1}
.status{font-size:11px;font-weight:640;color:#e7f4d9;white-space:nowrap;padding:0 6px 0 2px;max-width:190px;overflow:hidden;text-overflow:ellipsis}
.dock[data-state="idle"] .status,.dock[data-expanded="false"][data-quiet="true"] .status,.dock[data-expanded="false"][data-quiet="true"] .archive{display:none}
.toggle{display:grid;place-items:center;width:24px;height:30px;border:0;border-radius:15px;background:transparent;color:#a7b3a6;font-size:15px;line-height:1;padding:0}.toggle:hover{background:#ffffff12;color:#fff}
.dock[data-expanded="false"]:is([data-state="idle"],[data-quiet="true"]) .toggle{position:absolute;right:100%;top:50%;transform:translateY(-50%);height:26px;border-radius:13px;background:var(--ink);opacity:0;pointer-events:none}
.dock[data-expanded="false"]:is([data-state="idle"],[data-quiet="true"]):is(:hover,:focus-within) .toggle{opacity:1;pointer-events:auto}
.button{border:1px solid #485d40;background:#29342a;color:#e7f1df;min-height:31px;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:630}.button:hover{background:#344530}.button:disabled{opacity:.4;cursor:default}.button.primary{background:var(--acid);border-color:var(--acid);color:#1b2a10}.button.primary:hover{background:#dffaaf}
.bar .button{border-radius:15px;min-height:28px;padding:4px 10px;font-size:10px;white-space:nowrap}.bar .cancel{border-color:transparent;background:#ffffff0b;color:#c7d0c3}
.receipt{padding:2px 14px 12px;width:270px;max-width:calc(100vw - 26px)}.dock[data-expanded="false"]:not([data-state="error"]) .receipt{display:none}
.title{font-size:13px;font-weight:680;letter-spacing:-.1px;line-height:1.35;margin:2px 0 5px}.detail{font-size:11px;line-height:1.5;color:var(--muted);margin:0;overflow-wrap:anywhere}.snippet{font-size:11px;line-height:1.45;margin:10px 0 0;padding:7px 9px;background:#ffffff04;border-left:2px solid #a9c985;color:#dce5d3;white-space:pre-wrap;overflow:hidden;max-height:48px;overflow-wrap:anywhere}
.announcement{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dock[data-state="error"]{border-color:#b58a5b}.dock[data-state="error"] .title{color:#f1d4a5}.dock[data-state="error"] .mark{fill:#e2b36f}.dock[data-state="saving"] .mark{fill:#d3b779}.dock[data-state="arming"] .mark,.dock[data-state="armed"] .mark{fill:var(--acid)}
.panel{border-top:1px solid #344132;padding:11px 14px 13px;width:270px;max-width:calc(100vw - 26px)}.controls{display:flex;gap:7px;flex-wrap:wrap}.key{font-size:10px;line-height:1.6;color:#a5b59e;margin:10px 0 0}.instruction{font-size:11px;color:#d7e2ce;line-height:1.5;margin:0 0 10px}.close{margin-top:10px;border:0;background:none;color:#a7b3a6;font-size:10px;padding:2px 0;text-decoration:underline;text-underline-offset:2px}.close:hover{color:#fff}
.ghost{border-top:1px solid #344132;padding:11px 14px 13px;width:270px;max-width:calc(100vw - 26px)}.ghost-label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#a7c78d;margin:0 0 6px}.ghost a{font-size:12px;font-weight:640;color:#e4f6d4;text-decoration:none;overflow-wrap:anywhere}.ghost a:hover{text-decoration:underline}.ghost p{font-size:11px;line-height:1.45;color:var(--muted);margin:6px 0 0;overflow-wrap:anywhere}.ghost-dismiss{float:right;border:0;background:none;color:var(--muted);font-size:10px;cursor:pointer;padding:0 0 4px 7px}
.ghost-indicator{position:absolute;top:5px;right:5px;width:7px;height:7px;background:#cff890;border-radius:50%;box-shadow:0 0 6px #cff890a0}
.chip{position:fixed;z-index:2147483647;display:grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid #2c3a26;border-radius:15px;background:var(--acid);box-shadow:0 3px 10px #10201440;animation:chip-in .16s ease-out}.chip:hover{background:#dffaaf;transform:scale(1.08)}.chip .mark{width:15px;height:17px;fill:#24361a;stroke:none}
@keyframes chip-in{from{opacity:0;transform:translateY(4px) scale(.8)}}
.targets{pointer-events:none;position:fixed;inset:0;z-index:2147483644}.target{position:fixed;border:1px solid #789e32;border-radius:3px;background:#c4f77721;box-shadow:0 0 0 2px #efffd350;pointer-events:none}.targets[data-state="arming"] .target{border-style:dashed}.targets[data-state="saving"] .target{background:#c4f7770d;border-color:#8da56480}.trail{pointer-events:none;position:fixed;inset:0;width:100vw;height:100vh;overflow:visible;z-index:2147483645}.trail path{fill:none;stroke:#619c32;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 1px #f3ffdf)}.trail .trail-halo{stroke:#f0ffe7b0;stroke-width:5}.trail circle{fill:#cff890;stroke:#4d712b;stroke-width:1.5}
.effect{position:fixed;inset:0;pointer-events:none;z-index:2147483646}
.grave{position:absolute;inset:0;overflow:hidden;--paper:#fff;--paper-ink:#28301f;--paper-font:Georgia,"Times New Roman",serif;--paper-size:16px}
.grave canvas,.grave-patches div,.grave-scrap{position:absolute;left:0;top:0}.grave-patches div{background:var(--paper)}
.grave-hand{-webkit-mask-image:linear-gradient(to right,transparent,#000 7%,#000 93%,transparent),linear-gradient(to bottom,transparent,#000 7%,#000 93%,transparent);-webkit-mask-composite:source-in;mask-image:linear-gradient(to right,transparent,#000 7%,#000 93%,transparent),linear-gradient(to bottom,transparent,#000 7%,#000 93%,transparent);mask-composite:intersect}
.grave-scrap{transform-origin:0 0;filter:drop-shadow(0 1px 2px #00000050)}
.slip{box-sizing:border-box;background:var(--paper);background-image:linear-gradient(170deg,#ffffff1f,#0000000a);color:var(--paper-ink);font:var(--paper-size)/1.3 var(--paper-font);overflow:hidden}
.slip p{margin:0;overflow:hidden;overflow-wrap:anywhere}
.slip.text{padding:1px 4px;white-space:nowrap;max-width:12em;clip-path:polygon(0 8%,9% 0,23% 6%,41% 0,58% 7%,74% 1%,88% 6%,100% 0,97% 52%,100% 100%,82% 93%,64% 100%,47% 92%,30% 100%,14% 94%,0 100%,3% 48%)}.slip.text p{text-overflow:ellipsis}
.slip.page{width:168px;height:96px;padding:12px 14px;font-size:12px;clip-path:polygon(0 7%,4% 0,11% 5%,19% 1%,27% 5%,36% 0,44% 6%,53% 1%,62% 5%,70% 0,79% 6%,87% 1%,95% 5%,100% 1%,99% 24%,100% 47%,98% 71%,100% 94%,94% 100%,86% 95%,77% 100%,68% 96%,59% 100%,50% 95%,41% 100%,32% 96%,23% 100%,14% 95%,5% 100%,0 95%,2% 72%,0 49%,2% 26%)}
.slip.page p{display:-webkit-box;-webkit-box-orient:vertical}.slip.page .grabbed{font-weight:700;font-size:14px;line-height:1.25;-webkit-line-clamp:2}.slip.page .host{margin-top:3px;font:10px/1.3 system-ui,sans-serif;opacity:.65;-webkit-line-clamp:1}.slip.page i{display:block;height:4px;margin-top:7px;border-radius:2px;background:currentColor;opacity:.14}.slip.page i:nth-of-type(2){width:86%}.slip.page i:nth-of-type(3){width:62%}
@media(max-width:420px){.dock{right:10px;bottom:10px}.receipt,.panel,.ghost{width:250px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

export class HandView {
  readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly dock: HTMLDivElement;
  private readonly targets: HTMLDivElement;
  private readonly trail: SVGSVGElement;
  private readonly trailPaths: SVGPathElement[];
  private readonly trailStart: SVGCircleElement;
  private readonly effect: HTMLDivElement;
  private readonly grave: GraveEffect;
  private readonly title: HTMLHeadingElement;
  private readonly announcement: HTMLSpanElement;
  private readonly detail: HTMLParagraphElement;
  private readonly snippet: HTMLParagraphElement;
  private readonly grabButton: HTMLButtonElement;
  private readonly status: HTMLSpanElement;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly captureButton: HTMLButtonElement;
  private readonly pageButton: HTMLButtonElement | null;
  private readonly cancelButton: HTMLButtonElement;
  private readonly archiveButton: HTMLButtonElement;
  private readonly chip: HTMLButtonElement;
  private readonly ghost: HTMLDivElement;
  private readonly ghostIndicator: HTMLSpanElement;
  private readonly ghostLink: HTMLAnchorElement;
  private readonly ghostText: HTMLParagraphElement;
  private readonly listeners = new AbortController();
  private readonly effectTimers = new Set<number>();
  private quietTimer: number | undefined;
  private state: HandState = 'idle';
  private expanded = false;
  private ghostAvailable = false;
  private undoAvailable = false;
  private selectionAvailable = false;
  private disposed = false;
  private effectStartedAt = 0;
  private effectScene: Parameters<GraveEffect['start']>[0] | null = null;
  private targetActive = false;
  private readonly spriteRequests = new Map<number, Promise<void>>();
  /** The hand the next grab plays, chosen ahead so it can load while the user confirms. */
  private nextHand = pickHand();

  constructor(
    private readonly document: Document,
    private readonly actions: HandActions,
  ) {
    const node = <T extends keyof HTMLElementTagNameMap>(
      tag: T,
      className: string,
      text?: string,
    ): HTMLElementTagNameMap[T] => {
      const element = document.createElement(tag);
      element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const button = (className: string, text: string, title: string, action?: () => void) => {
      const element = node('button', className, text);
      element.type = 'button';
      element.title = title;
      if (action) element.addEventListener('click', action, { signal: this.listeners.signal });
      return element;
    };
    const mark = (): SVGSVGElement => {
      const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
      icon.setAttribute('class', 'mark');
      icon.setAttribute('viewBox', '0 0 24 28');
      icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NAMESPACE, 'path');
      path.setAttribute('d', HAND_PATH);
      icon.append(path);
      return icon;
    };
    this.host = node('div', '');
    this.host.dataset.zombieHandUi = 'true';
    this.host.style.setProperty('all', 'initial', 'important');
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.targets = node('div', 'targets');
    this.targets.hidden = true;
    this.targets.setAttribute('aria-hidden', 'true');
    this.trail = document.createElementNS(SVG_NAMESPACE, 'svg');
    this.trail.setAttribute('class', 'trail');
    this.trail.setAttribute('aria-hidden', 'true');
    this.trail.setAttribute('hidden', '');
    this.trailPaths = ['trail-halo', 'trail-line'].map((className) => {
      const path = document.createElementNS(SVG_NAMESPACE, 'path');
      path.setAttribute('class', className);
      this.trail.append(path);
      return path;
    });
    this.trailStart = document.createElementNS(SVG_NAMESPACE, 'circle');
    this.trailStart.setAttribute('r', '3.5');
    this.trail.append(this.trailStart);
    this.effect = node('div', 'effect');
    this.effect.hidden = true;
    this.effect.setAttribute('aria-hidden', 'true');
    this.grave = new GraveEffect(document);
    this.effect.append(this.grave.element);

    this.dock = node('div', 'dock');
    this.dock.dataset.state = 'idle';
    this.dock.dataset.expanded = 'false';
    this.dock.dataset.quiet = 'false';
    this.dock.setAttribute('role', 'region');
    this.dock.setAttribute('aria-label', 'Zombie Hand capture controls');
    const bar = node('div', 'bar');
    this.grabButton = button('grab', '', '', () => (actions.grab ?? actions.capture)());
    this.ghostIndicator = node('span', 'ghost-indicator');
    this.ghostIndicator.hidden = true;
    this.ghostIndicator.setAttribute('aria-hidden', 'true');
    this.grabButton.append(mark(), this.ghostIndicator);
    this.status = node('span', 'status');
    this.status.setAttribute('aria-hidden', 'true');
    this.cancelButton = button(
      'button cancel',
      'Cancel',
      'Cancel this capture (Escape)',
      actions.cancel,
    );
    this.cancelButton.hidden = true;
    this.archiveButton = button(
      'button archive',
      'Spit back',
      'Archive the last capture; its vault file is retained',
      actions.archive,
    );
    this.archiveButton.hidden = true;
    this.toggle = button('toggle', '⋯', 'More Zombie Hand controls', () =>
      this.setExpanded(!this.expanded),
    );
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.setAttribute('aria-controls', 'zombie-hand-secondary-controls');
    bar.append(this.grabButton, this.status, this.cancelButton, this.archiveButton, this.toggle);

    const receipt = node('div', 'receipt');
    this.announcement = node('span', 'announcement');
    this.announcement.setAttribute('role', 'status');
    this.announcement.setAttribute('aria-live', 'polite');
    this.announcement.setAttribute('aria-atomic', 'true');
    this.title = node('h2', 'title', 'Ready when you are.');
    this.detail = node('p', 'detail', 'Select text or click the hand to grab this page.');
    this.snippet = node('p', 'snippet');
    this.snippet.hidden = true;
    receipt.append(this.title, this.detail, this.snippet);

    this.panel = node('div', 'panel');
    this.panel.id = 'zombie-hand-secondary-controls';
    this.panel.hidden = true;
    const controls = node('div', 'controls');
    this.captureButton = button(
      'button primary',
      'Grab selection',
      'Capture the selected text (Alt+Shift+Z)',
      actions.capture,
    );
    controls.append(this.captureButton);
    this.pageButton = actions.page
      ? button(
          'button',
          'Save page',
          'Save this page: title, link and a text excerpt',
          actions.page,
        )
      : null;
    if (this.pageButton) controls.append(this.pageButton);
    const close = button(
      'close',
      'Pause everywhere',
      'Pause Zombie Hand everywhere',
      actions.close,
    );
    this.panel.append(
      node(
        'p',
        'instruction',
        'Select text and click the hand, or click it with nothing selected to grab the page. Hold Shift or Ctrl and circle a sentence, image or video.',
      ),
      controls,
      node(
        'p',
        'key',
        'Alt + Shift + Z: grab the selection or what the pointer is on · Escape: cancel',
      ),
      close,
    );
    this.ghost = node('div', 'ghost');
    this.ghost.hidden = true;
    const dismiss = button('ghost-dismiss', 'Dismiss', 'Dismiss this related note', () =>
      this.setGhost(null),
    );
    this.ghostLink = node('a', '');
    this.ghostLink.target = '_blank';
    this.ghostLink.rel = 'noopener noreferrer';
    this.ghostText = node('p', '');
    this.ghost.append(
      dismiss,
      node('p', 'ghost-label', 'A note came back'),
      this.ghostLink,
      this.ghostText,
    );
    this.dock.append(bar, receipt, this.panel, this.ghost, this.announcement);

    this.chip = button('chip', '', 'Grab selection (Alt+Shift+Z)', actions.capture);
    this.chip.setAttribute('aria-label', 'Grab the selected text');
    this.chip.append(mark());
    this.chip.hidden = true;
    // Pressing a grab control must not collapse the page selection it is about to take.
    for (const control of [this.chip, this.grabButton, this.captureButton])
      control.addEventListener('mousedown', (event) => event.preventDefault(), {
        signal: this.listeners.signal,
      });

    this.shadow.append(style, this.targets, this.trail, this.effect, this.chip, this.dock);
    this.updateGrabLabel();
    document.documentElement.append(this.host);
  }

  contains(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  move(_x: number, _y: number): void {
    // The hand belongs to a confirmed target, never to ordinary cursor movement.
  }

  setTarget(
    rectangle: TargetRectangle | null,
    snippet = '',
    rectangles?: readonly Rectangle[],
    presentation: TargetPresentation = {},
  ): void {
    this.targetActive = rectangle !== null;
    this.targets.replaceChildren();
    this.targets.hidden = rectangle === null || presentation.kind === 'page';
    if (rectangle) {
      const targetRectangles = rectangles?.length ? rectangles : [rectangle];
      for (const area of presentation.kind === 'page' ? [] : targetRectangles.slice(0, 64)) {
        if (![area.x, area.y, area.width, area.height].every(Number.isFinite)) continue;
        const left = Math.max(0, area.x - 2);
        const top = Math.max(0, area.y - 1);
        const right = Math.min(rectangle.viewportWidth, area.x + area.width + 2);
        const bottom = Math.min(rectangle.viewportHeight, area.y + area.height + 1);
        if (right <= left || bottom <= top) continue;
        const target = this.document.createElement('div');
        target.className = 'target';
        target.style.left = `${left}px`;
        target.style.top = `${top}px`;
        target.style.width = `${right - left}px`;
        target.style.height = `${bottom - top}px`;
        this.targets.append(target);
      }
      this.effectScene = {
        kind: presentation.kind ?? 'text',
        source: rectangle,
        rectangles: (presentation.highlight?.length
          ? presentation.highlight
          : targetRectangles
        ).slice(0, 128),
        viewport: { width: rectangle.viewportWidth, height: rectangle.viewportHeight },
        text: snippet,
        ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
        ...(presentation.style ? { style: presentation.style } : {}),
      };
      // Load the next hand while the user confirms, so it is ready to burst through.
      this.loadSprite(this.nextHand);
    }
    this.snippet.textContent = snippet.slice(0, 220);
    this.snippet.hidden = snippet.length === 0;
  }

  setTrail(points: readonly Point[]): void {
    const visiblePoints = points
      .slice(-256)
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const first = visiblePoints[0];
    if (!first) {
      this.trail.setAttribute('hidden', '');
      for (const path of this.trailPaths) path.removeAttribute('d');
      return;
    }
    const pathData = visiblePoints
      .map(
        (point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
      )
      .join(' ');
    for (const path of this.trailPaths) path.setAttribute('d', pathData);
    this.trailStart.setAttribute('cx', first.x.toString());
    this.trailStart.setAttribute('cy', first.y.toString());
    this.trail.removeAttribute('hidden');
  }

  /**
   * Show the one-click grab chip beside a finished selection, or hide it.
   * `selected` keeps the hand button's label honest while the chip is hidden.
   */
  setSelectionChip(point: Point | null, selected = point !== null): void {
    const view = this.document.defaultView;
    const usable =
      point !== null &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      !['arming', 'armed', 'saving'].includes(this.state);
    this.selectionAvailable = selected;
    this.updateGrabLabel();
    if (!usable || !view) {
      this.chip.hidden = true;
      return;
    }
    this.chip.style.left = `${Math.max(4, Math.min(view.innerWidth - 34, point.x + 6))}px`;
    this.chip.style.top = `${Math.max(4, Math.min(view.innerHeight - 34, point.y + 4))}px`;
    this.chip.hidden = false;
  }

  setState(state: HandState, title: string, detail: string): void {
    const previous = this.state;
    this.state = state;
    this.dock.dataset.state = state;
    this.targets.dataset.state = state;
    this.title.textContent = title;
    this.detail.textContent = detail;
    this.announcement.textContent = `${title} ${detail}`;
    this.status.textContent =
      state === 'saved' ? 'Buried in Obsidian' : state === 'error' ? 'Needs attention' : title;
    const busy = state === 'saving' || state === 'arming';
    this.captureButton.disabled = busy;
    this.grabButton.disabled = busy;
    if (this.pageButton) this.pageButton.disabled = busy;
    this.captureButton.textContent = state === 'armed' ? 'Grab this' : 'Grab selection';
    this.cancelButton.hidden = !['arming', 'armed', 'saving'].includes(state);
    if (['arming', 'armed', 'saving'].includes(state)) this.chip.hidden = true;
    this.updateUndo();
    this.updateGrabLabel();
    this.setQuiet(false);
    if (state === 'saved' || state === 'archived')
      this.quietTimer = this.document.defaultView?.setTimeout(() => {
        this.quietTimer = undefined;
        if (!this.disposed) this.setQuiet(true);
      }, QUIET_AFTER_MS);
    if (state === 'saving' && previous !== 'saving') this.startEffect();
    else if (state === 'saved' && previous !== 'saved') this.retreatEffect(true);
    else if (['arming', 'armed'].includes(state) && state !== previous) this.hideEffect();
    else if (['idle', 'archived', 'error'].includes(state) && state !== previous)
      this.retreatEffect(false);
  }

  setUndoAvailable(available: boolean): void {
    this.undoAvailable = available;
    this.updateUndo();
  }

  setGhost(result: SearchResult | null): void {
    this.ghostAvailable = false;
    if (result) {
      try {
        const url = new URL(result.sourceUrl);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          this.ghostLink.href = url.href;
          this.ghostLink.textContent = result.capture.candidate.title;
          this.ghostText.textContent = result.excerpt.slice(0, 220);
          this.ghostAvailable = true;
        }
      } catch {
        // Untrusted references never become navigation targets.
      }
    }
    if (!this.ghostAvailable) {
      this.ghostLink.removeAttribute('href');
      this.ghostLink.textContent = '';
      this.ghostText.textContent = '';
    }
    this.ghost.hidden = !this.ghostAvailable || !this.expanded;
    this.ghostIndicator.hidden = !this.ghostAvailable || this.expanded;
    this.updateToggleLabel();
  }

  setHidden(hidden: boolean): void {
    this.host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.abort();
    this.setQuiet(false);
    this.hideEffect();
    this.host.remove();
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.dock.dataset.expanded = String(expanded);
    this.toggle.setAttribute('aria-expanded', String(expanded));
    this.panel.hidden = !expanded;
    this.ghost.hidden = !expanded || !this.ghostAvailable;
    this.ghostIndicator.hidden = expanded || !this.ghostAvailable;
    this.updateToggleLabel();
  }

  private setQuiet(quiet: boolean): void {
    if (this.quietTimer !== undefined) this.document.defaultView?.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    this.dock.dataset.quiet = String(quiet);
  }

  private updateToggleLabel(): void {
    this.toggle.setAttribute(
      'aria-label',
      `${this.expanded ? 'Collapse' : 'Open'} Zombie Hand capture controls${this.ghostAvailable ? '; related note available' : ''}`,
    );
  }

  private updateGrabLabel(): void {
    const label = this.selectionAvailable ? 'Grab the selected text' : 'Grab this page';
    this.grabButton.setAttribute('aria-label', label);
    this.grabButton.title = `${label}. Shift/Ctrl + circle grabs a sentence, image or video.`;
  }

  private updateUndo(): void {
    this.archiveButton.hidden =
      !this.undoAvailable || ['arming', 'armed', 'saving'].includes(this.state);
  }

  private reducedMotion(): boolean {
    return (
      this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    );
  }

  /** Loads a hand's frames once per page; a failed load is retried at the next target. */
  private loadSprite(hand: number): void {
    if (this.spriteRequests.has(hand) || !this.actions.sprite) return;
    this.spriteRequests.set(
      hand,
      this.actions.sprite(hand).then(
        (sprite) => {
          if (!sprite) this.spriteRequests.delete(hand);
          else if (!this.disposed) this.grave.useFootage(hand, sprite);
        },
        () => {
          this.spriteRequests.delete(hand);
        },
      ),
    );
  }

  private startEffect(): void {
    this.hideEffect();
    if (!this.targetActive || !this.effectScene || this.disposed) return;
    // A different hand each time: never the one that played last.
    const hand = this.nextHand;
    this.nextHand = pickHand(hand);
    this.loadSprite(hand);
    this.effect.dataset.phase = 'reach';
    this.effect.hidden = false;
    this.grave.start(this.effectScene, hand);
    if (this.reducedMotion()) this.grave.hold();
    this.effectStartedAt = this.document.defaultView?.performance.now() ?? 0;
    // The decorative hand must not obscure a passage while an offline queue waits.
    // Its neutral fade changes presentation only; the receipt retains the real save state.
    const linger = this.grave.grabEnd + 1_100;
    this.later(() => {
      this.effect.dataset.phase = 'fade';
      this.grave.fade();
    }, linger);
    this.later(() => this.hideEffect(), linger + GRAVE_DURATION.fade);
  }

  private retreatEffect(saved: boolean): void {
    if (this.effect.hidden || this.disposed) return;
    this.clearEffectTimers();
    if (this.effect.dataset.phase === 'fade') {
      this.later(() => this.hideEffect(), GRAVE_DURATION.fade);
      return;
    }
    if (this.reducedMotion()) {
      this.hideEffect();
      return;
    }
    const elapsed = (this.document.defaultView?.performance.now() ?? 0) - this.effectStartedAt;
    // A fast save still lets the hand finish its grab before it pulls the copy under.
    const delay = saved ? Math.max(0, this.grave.grabEnd + 60 - elapsed) : 0;
    this.later(() => {
      this.effect.dataset.phase = saved ? 'bury' : 'release';
      const duration = saved ? this.grave.bury() : this.grave.release();
      this.later(() => this.hideEffect(), duration);
    }, delay);
  }

  private later(action: () => void, delay: number): void {
    const view = this.document.defaultView;
    if (!view) return;
    const timer = view.setTimeout(() => {
      this.effectTimers.delete(timer);
      if (!this.disposed) action();
    }, delay);
    this.effectTimers.add(timer);
  }

  private clearEffectTimers(): void {
    for (const timer of this.effectTimers) this.document.defaultView?.clearTimeout(timer);
    this.effectTimers.clear();
  }

  private hideEffect(): void {
    this.clearEffectTimers();
    this.grave.hide();
    this.effect.hidden = true;
    delete this.effect.dataset.phase;
  }
}
