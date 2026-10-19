import type { CaptureCandidate, SearchResult } from '../core/contracts/index';

type TargetRectangle = NonNullable<CaptureCandidate['image']>['rect'];
type Rectangle = Pick<TargetRectangle, 'x' | 'y' | 'width' | 'height'>;
type Point = Pick<Rectangle, 'x' | 'y'>;

export type HandState = 'idle' | 'arming' | 'armed' | 'saving' | 'saved' | 'archived' | 'error';
export interface HandActions {
  capture: () => void;
  cancel: () => void;
  archive: () => void;
  close: () => void;
  page?: () => void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const STYLE = `
:host{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#f4f4ed!important;--acid:#cff890;--ink:#171d1b;--muted:#b5bfb8}
*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid var(--acid);outline-offset:3px}[hidden]{display:none!important}
.dock{position:fixed;right:18px;bottom:18px;max-width:calc(100vw - 24px);background:var(--ink);border:1px solid #475447;border-radius:23px;box-shadow:0 5px 20px #10201425;color:#f4f4ed;z-index:2147483647;overflow:visible}
.bar{display:flex;align-items:center;min-height:42px;padding:2px 6px 2px 5px;gap:3px}.toggle{display:flex;align-items:center;gap:8px;min-height:36px;padding:0 9px;border:0;border-radius:18px;background:transparent;color:#e7f4d9;font-size:11px;font-weight:640;white-space:nowrap}.toggle:hover{background:#ffffff0a}.mark{width:18px;height:20px;fill:#aacc83;stroke:#e0f8c0;stroke-width:1.1;flex:none}.chevron{font-size:10px;color:#91a68b;margin-left:4px}.close{border:0;background:none;color:#a7b3a6;font-size:19px;width:31px;height:34px;border-radius:16px;line-height:1}.close:hover{background:#ffffff12;color:white}.button{border:1px solid #485d40;background:#29342a;color:#e7f1df;min-height:33px;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:630}.button:hover{background:#344530}.button:disabled{opacity:.4;cursor:default}.button.primary{background:var(--acid);border-color:var(--acid);color:#1b2a10}.button.primary:hover{background:#dffaaf}.bar .button{border-radius:16px;min-height:30px;padding:5px 10px;font-size:10px}.bar .cancel{border-color:transparent;background:#ffffff09;color:#c7d0c3}.archive{white-space:nowrap}
.receipt{padding:1px 15px 14px;width:284px;max-width:calc(100vw - 26px)}.title{font-size:13px;font-weight:680;letter-spacing:-.1px;line-height:1.35;margin:2px 0 5px}.detail{font-size:11px;line-height:1.5;color:var(--muted);margin:0;overflow-wrap:anywhere}.snippet{font-size:11px;line-height:1.45;margin:10px 0 0;padding:7px 9px;background:#ffffff04;border-left:2px solid #a9c985;color:#dce5d3;white-space:pre-wrap;overflow:hidden;max-height:48px;overflow-wrap:anywhere}.dock[data-expanded="false"][data-state="idle"] .receipt{display:none}.dock[data-expanded="false"][data-state="saved"] .receipt{display:none}.announcement{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.dock[data-state="error"]{border-color:#b58a5b}.dock[data-state="error"] .title{color:#f1d4a5}.dock[data-state="saving"] .mark{fill:#d3b779}.dock[data-state="arming"] .mark,.dock[data-state="armed"] .mark{fill:var(--acid)}
.panel{border-top:1px solid #344132;padding:11px 14px 14px;width:284px;max-width:calc(100vw - 26px)}.controls{display:flex;gap:7px;flex-wrap:wrap}.key{font-size:10px;line-height:1.6;color:#a5b59e;margin:10px 0 0}.instruction{font-size:11px;color:#d7e2ce;line-height:1.5;margin:0 0 10px}
.targets{pointer-events:none;position:fixed;inset:0;z-index:2147483644}.target{position:fixed;border:1px solid #789e32;border-radius:3px;background:#c4f77721;box-shadow:0 0 0 2px #efffd350;pointer-events:none}.targets[data-state="arming"] .target{border-style:dashed}.targets[data-state="saving"] .target{background:#c4f7770d;border-color:#8da56480}.trail{pointer-events:none;position:fixed;inset:0;width:100vw;height:100vh;overflow:visible;z-index:2147483645}.trail path{fill:none;stroke:#619c32;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 1px #f3ffdf)}.trail .trail-halo{stroke:#f0ffe7b0;stroke-width:5}.trail circle{fill:#cff890;stroke:#4d712b;stroke-width:1.5}
.effect{position:fixed;width:200px;height:200px;pointer-events:none;z-index:2147483646;isolation:isolate;transform:translate(-50%,-50%);perspective:550px;--soil:#85714d}.effect:before{content:"";position:absolute;inset:52px 33px 44px;border-radius:50%;background:#1a24044a;filter:blur(15px);transform:scale(.8);opacity:0;animation:ground-shadow .75s ease-out forwards}.grave{position:absolute;left:35px;top:55px;width:130px;height:108px;transform:scale(.08);opacity:0;animation:open-grave .32s cubic-bezier(.2,.85,.25,1) forwards}.earth{position:absolute;inset:0;clip-path:polygon(5% 34%,13% 19%,26% 17%,33% 6%,46% 11%,61% 4%,73% 14%,86% 16%,89% 31%,99% 44%,93% 59%,96% 76%,83% 83%,72% 96%,55% 93%,42% 100%,30% 89%,16% 87%,12% 72%,0% 61%,5% 48%);background:radial-gradient(ellipse at 51% 51%,#080e09 0 38%,#211e13 40% 50%,#554c31 54%,#998055 64%,#5c5237 72%,#b39e70 81%);box-shadow:inset 0 -8px 9px #a4966a}.earth:after{content:"";position:absolute;inset:17px 19px 18px;border-radius:45% 52% 43% 49%;background:radial-gradient(ellipse at 50% 70%,#3e3b1a,#10170c 65%);box-shadow:inset 3px 8px 15px #000e,0 1px 0 #c9af7b80}.crack{position:absolute;inset:-14px;clip-path:polygon(47% 34%,34% 23%,29% 8%,33% 27%,43% 39%,20% 40%,5% 31%,17% 44%,39% 47%,18% 66%,10% 84%,23% 69%,44% 57%,40% 81%,44% 96%,46% 76%,52% 58%,72% 74%,89% 76%,75% 70%,59% 51%,83% 49%,97% 37%,80% 44%,58% 42%,70% 19%,66% 8%,65% 25%,53% 37%);background:#4a4626a8}.pebble{position:absolute;width:7px;height:5px;border-radius:40% 60% 35% 45%;background:#9c875b;box-shadow:inset -2px -1px 0 #675e3b;animation:scatter .6s ease-out forwards}.pebble.p1{left:29px;top:48px;--dx:-17px;--dy:-12px;transform:rotate(35deg)}.pebble.p2{left:150px;top:72px;--dx:17px;--dy:-6px}.pebble.p3{left:139px;top:155px;--dx:13px;--dy:14px;width:9px}.pebble.p4{left:37px;top:141px;--dx:-14px;--dy:13px}.pebble.p5{left:102px;top:47px;--dx:5px;--dy:-15px;width:4px}
.hand{position:absolute;left:53px;top:12px;width:94px;height:135px;transform-origin:50% 90%;transform:translateY(53px) scale(.12) rotate(9deg);opacity:0;filter:drop-shadow(0 9px 5px #0005);animation:emerge .7s cubic-bezier(.18,.75,.25,1) forwards;transform-style:preserve-3d}.arm{position:absolute;left:31px;top:91px;width:40px;height:45px;background:linear-gradient(90deg,#35472e,#67894d 32%,#8da661 60%,#3b5734);clip-path:polygon(5% 0,91% 1%,100% 100%,0 100%);border:2px solid #34432c;border-radius:12px 10px 0 0}.cuff{position:absolute;left:28px;top:104px;width:47px;height:22px;background:linear-gradient(95deg,#3c3e3c,#6c6d58 60%,#343b33);clip-path:polygon(0 12%,15% 5%,18% 25%,34% 9%,51% 24%,72% 0,80% 17%,98% 8%,100% 93%,0 100%);box-shadow:inset 0 -4px 4px #141c1650}.palm{position:absolute;left:23px;top:55px;width:57px;height:58px;border:2px solid #3f552f;border-radius:38% 34% 35% 41%;background:radial-gradient(ellipse at 35% 25%,#c2d58b,#98b96d 45%,#5d8148 83%);box-shadow:inset 3px 3px 3px #e2eba040,inset -5px -6px 7px #344f3038}.palm:before{content:"";position:absolute;left:13px;top:15px;width:28px;height:19px;border-top:2px solid #627c44;border-bottom:1px solid #728f4e;transform:rotate(-17deg);border-radius:40%}.palm:after{content:"";position:absolute;left:5px;top:31px;width:12px;height:12px;border-right:1px solid #536f40;border-radius:50%;transform:rotate(-35deg)}.finger{position:absolute;width:16px;border:2px solid #405632;border-radius:10px 9px 7px 7px;background:linear-gradient(90deg,#7f9e59,#c4d997 40%,#92b36c 74%,#628447);transform-origin:50% 92%;box-shadow:inset 0 -5px 5px #4b6e4233;animation:grasp .32s .52s ease-in forwards;--curl:55deg;--splay:0deg}.finger:before{content:"";position:absolute;left:2px;top:3px;width:8px;height:10px;border-radius:6px 6px 3px 3px;background:linear-gradient(110deg,#e2deab,#a2aa74);border:1px solid #82945b;box-shadow:inset 0 1px 1px #fff7}.finger:after{content:"";position:absolute;left:2px;right:2px;bottom:11px;height:6px;border-top:1px solid #739054;border-bottom:1px solid #739054;border-radius:50%}.f1{left:10px;top:52px;height:40px;--splay:-48deg;--curl:35deg;transform:rotate(-48deg)}.f2{left:23px;top:14px;height:57px;--splay:-12deg;transform:rotate(-12deg)}.f3{left:41px;top:3px;height:64px;--splay:-2deg;--curl:63deg;transform:rotate(-2deg)}.f4{left:59px;top:13px;height:56px;--splay:10deg;--curl:61deg;transform:rotate(10deg)}.f5{left:75px;top:32px;height:43px;--splay:24deg;--curl:50deg;transform:rotate(24deg)}.grabbed{position:absolute;left:50%;top:69px;width:151px;max-height:37px;overflow:hidden;padding:5px 8px;border:1px solid #89905c;border-radius:3px;background:#f9f3d9;color:#293024;font:10px/1.25 Georgia,serif;box-shadow:0 3px 7px #0004;transform:translateX(-50%) rotate(-5deg) scale(.5);opacity:0;overflow-wrap:anywhere;animation:catch-copy .25s .43s ease-out forwards;z-index:1}.hand .f2,.hand .f3,.hand .f4,.hand .f5{z-index:2}.hand .palm{z-index:3}.hand .f1{z-index:4}
.effect[data-phase="fade"]{animation:fade-effect .4s ease-out forwards}.effect[data-phase="bury"] .hand{opacity:1;animation:bury-hand .58s cubic-bezier(.55,.05,.8,.45) forwards}.effect[data-phase="bury"] .grave{opacity:1;animation:close-grave .5s .16s ease-in forwards;transform:scale(1)}.effect[data-phase="bury"]:before,.effect[data-phase="release"]:before{animation:fade-ground .6s ease-in forwards}.effect[data-phase="bury"] .pebble,.effect[data-phase="release"] .pebble{opacity:0;animation:none}.effect[data-phase="release"] .hand{opacity:1;animation:release-hand .36s ease-in forwards}.effect[data-phase="release"] .grave{opacity:1;transform:scale(1);animation:close-grave .4s ease-in forwards}.effect[data-phase="release"] .grabbed{display:none}
.ghost{border-top:1px solid #344132;padding:11px 15px 14px;width:284px;max-width:calc(100vw - 26px)}.ghost-label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#a7c78d;margin:0 0 6px}.ghost a{font-size:12px;font-weight:640;color:#e4f6d4;text-decoration:none;overflow-wrap:anywhere}.ghost a:hover{text-decoration:underline}.ghost p{font-size:11px;line-height:1.45;color:var(--muted);margin:6px 0 0;overflow-wrap:anywhere}.ghost-dismiss{float:right;border:0;background:none;color:var(--muted);font-size:10px;cursor:pointer;padding:0 0 4px 7px}.ghost-indicator{width:6px;height:6px;background:#cff890;border-radius:50%;box-shadow:0 0 6px #cff89070}
@keyframes fade-effect{to{opacity:0}}@keyframes open-grave{to{transform:scale(1);opacity:1}}@keyframes ground-shadow{to{transform:scale(1);opacity:1}}@keyframes scatter{0%{opacity:0}30%{opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(35deg);opacity:.8}}@keyframes emerge{0%{opacity:0;transform:translateY(53px) scale(.12) rotate(9deg)}25%{opacity:1}72%{transform:translateY(-9px) scale(1.17) rotate(-9deg)}100%{opacity:1;transform:translateY(0) scale(1.04) rotate(-8deg)}}@keyframes grasp{to{transform:rotate(var(--splay)) perspective(120px) rotateX(var(--curl));filter:brightness(.9)}}@keyframes catch-copy{to{opacity:1;transform:translateX(-50%) rotate(-5deg) scale(1)}}@keyframes bury-hand{0%{transform:translateY(0) scale(1.04) rotate(-8deg)}25%{transform:translateY(7px) scale(.95) rotate(-7deg);opacity:1}100%{transform:translateY(57px) scale(.08) rotate(13deg);opacity:0}}@keyframes close-grave{to{transform:scale(.02);opacity:0}}@keyframes fade-ground{from{opacity:1}to{opacity:0}}@keyframes release-hand{from{transform:translateY(0) scale(1.04) rotate(-8deg)}to{transform:translateY(50px) scale(.1) rotate(8deg);opacity:0}}
@media(max-width:420px){.dock{right:12px;bottom:12px}.toggle{font-size:10px;padding:0 5px;gap:6px}.bar{gap:0}.bar .button{padding:5px 8px}.receipt,.panel,.ghost{width:260px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.effect:before{opacity:.4}.grave{opacity:1;transform:scale(1)}.hand{opacity:1;transform:translateY(9px) scale(.8) rotate(-8deg)}.grabbed{opacity:1;transform:translateX(-50%) rotate(-5deg)}.pebble{display:none}.effect[data-phase="bury"],.effect[data-phase="release"]{visibility:hidden}}
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
  private readonly grabbed: HTMLSpanElement;
  private readonly title: HTMLHeadingElement;
  private readonly announcement: HTMLSpanElement;
  private readonly detail: HTMLParagraphElement;
  private readonly snippet: HTMLParagraphElement;
  private readonly toggle: HTMLButtonElement;
  private readonly toggleLabel: HTMLSpanElement;
  private readonly panel: HTMLDivElement;
  private readonly captureButton: HTMLButtonElement;
  private readonly pageButton: HTMLButtonElement | null;
  private readonly cancelButton: HTMLButtonElement;
  private readonly archiveButton: HTMLButtonElement;
  private readonly ghost: HTMLDivElement;
  private readonly ghostIndicator: HTMLSpanElement;
  private readonly ghostLink: HTMLAnchorElement;
  private readonly ghostText: HTMLParagraphElement;
  private readonly listeners = new AbortController();
  private readonly effectTimers = new Set<number>();
  private state: HandState = 'idle';
  private expanded = false;
  private ghostAvailable = false;
  private undoAvailable = false;
  private disposed = false;
  private effectStartedAt = 0;
  private effectAnchor: Point | null = null;
  private effectSnippet = '';
  private targetActive = false;

  constructor(
    private readonly document: Document,
    actions: HandActions,
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
    const onClick = (element: HTMLElement, action: () => void): void => {
      element.addEventListener('click', action, { signal: this.listeners.signal });
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
    const grave = node('div', 'grave');
    grave.append(node('span', 'crack'), node('span', 'earth'));
    const hand = node('div', 'hand');
    this.grabbed = node('span', 'grabbed');
    hand.append(node('span', 'arm'), node('span', 'cuff'), this.grabbed);
    for (const className of [
      'finger f1',
      'finger f2',
      'finger f3',
      'finger f4',
      'finger f5',
      'palm',
    ])
      hand.append(node('span', className));
    this.effect.append(grave);
    for (let index = 1; index <= 5; index++) this.effect.append(node('span', `pebble p${index}`));
    this.effect.append(hand);
    this.dock = node('div', 'dock');
    this.dock.dataset.state = 'idle';
    this.dock.dataset.expanded = 'false';
    this.dock.setAttribute('role', 'region');
    this.dock.setAttribute('aria-label', 'Zombie Hand capture controls');
    const bar = node('div', 'bar');
    this.toggle = node('button', 'toggle');
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-label', 'Open Zombie Hand capture controls');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.setAttribute('aria-controls', 'zombie-hand-secondary-controls');
    const mark = document.createElementNS(SVG_NAMESPACE, 'svg');
    mark.setAttribute('class', 'mark');
    mark.setAttribute('viewBox', '0 0 24 28');
    mark.setAttribute('aria-hidden', 'true');
    const handPath = document.createElementNS(SVG_NAMESPACE, 'path');
    handPath.setAttribute(
      'd',
      'M8 25 5 20 1.5 15Q.5 13 2 12.5q1-.5 2 1L6 16 4.5 6Q4 3.8 6 3.7q1.5 0 1.8 2L9 12 9 3Q9 .7 11 .8q1.6 0 1.6 2L13 12l1-8q.3-2 2-1.7 1.8.3 1.5 2.2L17 14l2-6q.7-2 2.2-1.4 1.5.6.8 2.5L20 19l-3 6Z',
    );
    mark.append(handPath);
    this.toggleLabel = node('span', '', 'Shift / Ctrl + circle');
    this.ghostIndicator = node('span', 'ghost-indicator');
    this.ghostIndicator.hidden = true;
    this.ghostIndicator.setAttribute('aria-hidden', 'true');
    this.toggle.append(mark, this.toggleLabel, this.ghostIndicator, node('span', 'chevron', '⌃'));
    onClick(this.toggle, () => this.setExpanded(!this.expanded));
    this.cancelButton = node('button', 'button cancel', 'Cancel');
    this.cancelButton.type = 'button';
    this.cancelButton.hidden = true;
    this.cancelButton.title = 'Cancel this capture (Escape)';
    onClick(this.cancelButton, actions.cancel);
    this.archiveButton = node('button', 'button archive', 'Spit back');
    this.archiveButton.type = 'button';
    this.archiveButton.hidden = true;
    this.archiveButton.title = 'Archive the last capture; its vault file is retained';
    onClick(this.archiveButton, actions.archive);
    const close = node('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Pause Zombie Hand everywhere');
    close.title = 'Pause Zombie Hand everywhere';
    onClick(close, actions.close);
    bar.append(this.toggle, this.cancelButton, this.archiveButton, close);
    const receipt = node('div', 'receipt');
    this.announcement = node('span', 'announcement');
    this.announcement.setAttribute('role', 'status');
    this.announcement.setAttribute('aria-live', 'polite');
    this.announcement.setAttribute('aria-atomic', 'true');
    this.title = node('h2', 'title', 'Ready when you are.');
    this.detail = node('p', 'detail', 'Hold Shift or Ctrl and circle the words you want to keep.');
    this.snippet = node('p', 'snippet');
    this.snippet.hidden = true;
    receipt.append(this.title, this.detail, this.snippet);
    this.panel = node('div', 'panel');
    this.panel.id = 'zombie-hand-secondary-controls';
    this.panel.hidden = true;
    const controls = node('div', 'controls');
    this.captureButton = node('button', 'button primary', 'Grab selection');
    this.captureButton.type = 'button';
    this.captureButton.title = 'Capture selected text or the last pointed target (Alt+Shift+Z)';
    onClick(this.captureButton, actions.capture);
    controls.append(this.captureButton);
    this.pageButton = actions.page ? node('button', 'button', 'Save page') : null;
    if (this.pageButton && actions.page) {
      this.pageButton.type = 'button';
      this.pageButton.title = 'Save this page title and source link';
      onClick(this.pageButton, actions.page);
      controls.append(this.pageButton);
    }
    this.panel.append(
      node('p', 'instruction', 'Hold Shift or Ctrl, circle a passage, then release the key.'),
      controls,
      node('p', 'key', 'Alt + Shift + Z: grab selection · Escape: cancel'),
    );
    this.ghost = node('div', 'ghost');
    this.ghost.hidden = true;
    const dismiss = node('button', 'ghost-dismiss', 'Dismiss');
    dismiss.type = 'button';
    onClick(dismiss, () => this.setGhost(null));
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
    this.shadow.append(style, this.targets, this.trail, this.effect, this.dock);
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
  ): void {
    this.targetActive = rectangle !== null;
    this.targets.replaceChildren();
    this.targets.hidden = rectangle === null;
    if (rectangle) {
      const targetRectangles = rectangles?.length ? rectangles : [rectangle];
      for (const area of targetRectangles.slice(0, 64)) {
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
      this.effectAnchor = {
        x: Math.max(60, Math.min(rectangle.viewportWidth - 60, rectangle.x + rectangle.width / 2)),
        y: Math.max(
          70,
          Math.min(rectangle.viewportHeight - 55, rectangle.y + rectangle.height / 2),
        ),
      };
      this.effectSnippet = snippet.slice(0, 100);
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

  setState(state: HandState, title: string, detail: string): void {
    const previous = this.state;
    this.state = state;
    this.dock.dataset.state = state;
    this.targets.dataset.state = state;
    this.title.textContent = title;
    this.detail.textContent = detail;
    this.announcement.textContent = `${title} ${detail}`;
    this.toggleLabel.textContent =
      state === 'saving'
        ? 'Taking hold…'
        : state === 'saved'
          ? 'Saved to Obsidian'
          : state === 'archived'
            ? 'Spit back'
            : state === 'error'
              ? 'Capture needs attention'
              : 'Shift / Ctrl + circle';
    this.captureButton.disabled = state === 'saving' || state === 'arming';
    if (this.pageButton) this.pageButton.disabled = state === 'saving' || state === 'arming';
    this.captureButton.textContent = state === 'armed' ? 'Grab this' : 'Grab selection';
    this.cancelButton.hidden = !['arming', 'armed', 'saving'].includes(state);
    this.updateUndo();
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

  private updateToggleLabel(): void {
    this.toggle.setAttribute(
      'aria-label',
      `${this.expanded ? 'Collapse' : 'Open'} Zombie Hand capture controls${this.ghostAvailable ? '; related note available' : ''}`,
    );
  }

  private updateUndo(): void {
    this.archiveButton.hidden =
      !this.undoAvailable || ['arming', 'armed', 'saving'].includes(this.state);
  }

  private startEffect(): void {
    this.hideEffect();
    if (!this.targetActive || !this.effectAnchor || this.disposed) return;
    this.effect.style.left = `${this.effectAnchor.x}px`;
    this.effect.style.top = `${this.effectAnchor.y}px`;
    this.grabbed.textContent = this.effectSnippet || 'Source reference';
    this.effect.dataset.phase = 'reach';
    this.effect.hidden = false;
    this.effectStartedAt = this.document.defaultView?.performance.now() ?? 0;
    // The decorative hand must not obscure a passage while an offline queue waits.
    // Its neutral fade changes presentation only; the receipt retains the real save state.
    this.later(() => {
      this.effect.dataset.phase = 'fade';
    }, 1_800);
    this.later(() => this.hideEffect(), 2_200);
  }

  private retreatEffect(saved: boolean): void {
    if (this.effect.hidden || this.disposed) return;
    this.clearEffectTimers();
    if (this.effect.dataset.phase === 'fade') {
      this.later(() => this.hideEffect(), 400);
      return;
    }
    const elapsed = (this.document.defaultView?.performance.now() ?? 0) - this.effectStartedAt;
    const delay = saved ? Math.max(0, 760 - elapsed) : 0;
    this.later(() => {
      this.effect.dataset.phase = saved ? 'bury' : 'release';
    }, delay);
    this.later(() => this.hideEffect(), delay + (saved ? 690 : 440));
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
    this.effect.hidden = true;
    delete this.effect.dataset.phase;
  }
}
