import type { CaptureCandidate, SearchResult } from '../core/contracts/index';

type TargetRectangle = NonNullable<CaptureCandidate['image']>['rect'];

export type HandState = 'idle' | 'arming' | 'armed' | 'saving' | 'saved' | 'archived' | 'error';
export interface HandActions {
  capture: () => void;
  cancel: () => void;
  archive: () => void;
  close: () => void;
}

const STYLE = `
:host{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#f4f4ed!important;--acid:#caff81;--ink:#15181e;--muted:#aeb4b7}
*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid var(--acid);outline-offset:4px}
.dock{position:fixed;right:24px;bottom:24px;width:330px;max-width:calc(100vw - 32px);background:var(--ink);border:1px solid #3c4549;border-radius:19px;box-shadow:0 18px 65px #0006;overflow:hidden;color:#f4f4ed;z-index:2147483647}
.top{display:flex;gap:9px;align-items:center;padding:17px 18px 0}.dot{width:7px;height:7px;border-radius:50%;background:var(--acid);box-shadow:0 0 13px #caff8160}.brand{font-size:12px;font-weight:750;letter-spacing:.13em;text-transform:uppercase;flex:1}.close{border:0;background:none;color:var(--muted);font-size:17px;width:28px;height:28px;border-radius:8px}.close:hover{background:#ffffff12;color:white}
.body{padding:9px 18px 17px}.title{font-size:21px;font-weight:680;letter-spacing:-.6px;line-height:1.2;margin:0 0 8px}.detail{font-size:12px;line-height:1.55;color:var(--muted);margin:0;min-height:37px}.snippet{font-size:12px;line-height:1.5;margin:12px 0 0;padding:10px 12px;background:#ffffff05;border-left:2px solid #caff8180;color:#dbe0d9;white-space:pre-wrap;overflow:hidden;max-height:67px;overflow-wrap:anywhere}.snippet[hidden]{display:none}.controls{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap}.button{border:1px solid #435047;background:#242c29;color:#e9f2e4;padding:8px 11px;border-radius:8px;font-size:12px;font-weight:650}.button.primary{background:var(--acid);border-color:var(--acid);color:#14200b}.button:hover{filter:brightness(1.1)}.button:disabled{opacity:.4;cursor:default}.button[hidden]{display:none}.key{font-size:10px;color:#7f8a86;margin-top:12px;letter-spacing:.02em}
.target{pointer-events:none;position:fixed;border:2px solid #baff76;border-radius:7px;box-shadow:0 0 0 4px #baff7612,0 0 28px #baff7620;z-index:2147483645;transition:opacity .1s}.target[data-state="arming"]{border-style:dashed;opacity:.55}.target[hidden]{display:none}
.cursor{pointer-events:none;position:fixed;width:62px;height:72px;z-index:2147483646;transform:translate(18px,14px) rotate(-12deg);filter:drop-shadow(0 4px 5px #0006)}.cursor[hidden]{display:none}.palm{position:absolute;left:17px;top:24px;width:33px;height:33px;background:#9ecb78;border:2px solid #35503d;border-radius:9px 10px 14px 12px;transform:rotate(-7deg)}.palm:after{content:"";position:absolute;left:8px;top:7px;width:15px;height:11px;border-bottom:2px solid #557b4b;border-top:1px solid #557b4b;transform:rotate(-22deg)}.finger{position:absolute;width:10px;background:#b5da89;border:2px solid #35503d;border-radius:7px 7px 3px 3px;transform-origin:bottom}.f1{left:12px;top:21px;height:26px;transform:rotate(-42deg)}.f2{left:19px;top:7px;height:29px;transform:rotate(-10deg)}.f3{left:30px;top:2px;height:32px;transform:rotate(2deg)}.f4{left:41px;top:7px;height:28px;transform:rotate(12deg)}.f5{left:49px;top:20px;height:22px;transform:rotate(26deg)}.cuff{position:absolute;left:19px;top:52px;width:32px;height:17px;background:#66558c;border:2px solid #352d4b;border-radius:2px 2px 7px 7px;transform:rotate(-7deg)}
.cursor[data-state="armed"]{transform:translate(18px,14px) rotate(7deg)}.cursor[data-state="armed"] .finger,.cursor[data-state="saving"] .finger{height:15px;top:20px}.cursor[data-state="saving"]{animation:tremble .25s infinite alternate}.cursor[data-state="saved"]{transform:translate(18px,14px) rotate(-25deg)}
.ghost{border-top:1px solid #303a34;padding:13px 18px;background:#1c231e}.ghost[hidden]{display:none}.ghost-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#a7c78d;margin:0 0 6px}.ghost a{font-size:13px;font-weight:650;color:#e4f6d4;text-decoration:none}.ghost a:hover{text-decoration:underline}.ghost p{font-size:11px;line-height:1.45;color:var(--muted);margin:6px 0 0;overflow-wrap:anywhere}.ghost-dismiss{float:right;border:0;background:none;color:var(--muted);font-size:12px;cursor:pointer}
@keyframes tremble{from{transform:translate(18px,14px) rotate(-8deg)}to{transform:translate(18px,14px) rotate(5deg)}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

export class HandView {
  readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly dock: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly target: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly detail: HTMLParagraphElement;
  private readonly snippet: HTMLParagraphElement;
  private readonly captureButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly archiveButton: HTMLButtonElement;
  private readonly ghost: HTMLDivElement;
  private readonly ghostLink: HTMLAnchorElement;
  private readonly ghostText: HTMLParagraphElement;
  private undoAvailable = false;

  constructor(document: Document, actions: HandActions) {
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
    this.host = node('div', '');
    this.host.dataset.zombieHandUi = 'true';
    this.host.style.setProperty('all', 'initial', 'important');
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.target = node('div', 'target');
    this.target.hidden = true;
    this.cursor = node('div', 'cursor');
    this.cursor.hidden = true;
    this.cursor.setAttribute('aria-hidden', 'true');
    for (const className of [
      'finger f1',
      'finger f2',
      'finger f3',
      'finger f4',
      'finger f5',
      'palm',
      'cuff',
    ])
      this.cursor.append(node('span', className));
    this.dock = node('div', 'dock');
    this.dock.setAttribute('role', 'region');
    this.dock.setAttribute('aria-label', 'Zombie Hand capture controls');
    const top = node('div', 'top');
    const close = node('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Stop Zombie Hand on this page');
    close.addEventListener('click', actions.close);
    top.append(node('span', 'dot'), node('span', 'brand', 'Zombie Hand'), close);
    const body = node('div', 'body');
    this.title = node('h2', 'title', 'A little hungry.');
    this.detail = node(
      'p',
      'detail',
      'Pause over a phrase to wake the hand. Circle to grab. Shake to let go.',
    );
    this.detail.setAttribute('role', 'status');
    this.detail.setAttribute('aria-live', 'polite');
    this.snippet = node('p', 'snippet');
    this.snippet.hidden = true;
    const controls = node('div', 'controls');
    this.captureButton = node('button', 'button primary', 'Grab selection');
    this.captureButton.type = 'button';
    this.captureButton.title = 'Capture selected text or the last pointed target (Alt+Shift+Z)';
    this.captureButton.addEventListener('click', actions.capture);
    this.cancelButton = node('button', 'button', 'Let go');
    this.cancelButton.type = 'button';
    this.cancelButton.hidden = true;
    this.cancelButton.addEventListener('click', actions.cancel);
    this.archiveButton = node('button', 'button', 'Spit back');
    this.archiveButton.type = 'button';
    this.archiveButton.hidden = true;
    this.archiveButton.addEventListener('click', actions.archive);
    controls.append(this.captureButton, this.cancelButton, this.archiveButton);
    body.append(
      this.title,
      this.detail,
      this.snippet,
      controls,
      node('p', 'key', 'Alt + Shift + Z to grab · Esc to let go'),
    );
    this.ghost = node('div', 'ghost');
    this.ghost.hidden = true;
    const dismiss = node('button', 'ghost-dismiss', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => this.setGhost(null));
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
    this.dock.append(top, body, this.ghost);
    this.shadow.append(style, this.target, this.cursor, this.dock);
    document.documentElement.append(this.host);
  }

  contains(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  move(x: number, y: number): void {
    this.cursor.style.left = `${x}px`;
    this.cursor.style.top = `${y}px`;
    this.cursor.hidden = false;
  }

  setTarget(rectangle: TargetRectangle | null, snippet = ''): void {
    this.target.hidden = rectangle === null;
    if (rectangle) {
      this.target.style.left = `${Math.max(0, rectangle.x - 4)}px`;
      this.target.style.top = `${Math.max(0, rectangle.y - 3)}px`;
      this.target.style.width = `${Math.min(rectangle.width + 8, rectangle.viewportWidth)}px`;
      this.target.style.height = `${Math.min(rectangle.height + 6, rectangle.viewportHeight)}px`;
    }
    this.snippet.textContent = snippet.slice(0, 220);
    this.snippet.hidden = snippet.length === 0;
  }

  setState(state: HandState, title: string, detail: string): void {
    this.cursor.dataset.state = state;
    this.target.dataset.state = state;
    this.title.textContent = title;
    this.detail.textContent = detail;
    this.captureButton.disabled = state === 'saving' || state === 'arming';
    this.captureButton.textContent = state === 'armed' ? 'Grab this' : 'Grab selection';
    this.cancelButton.hidden = !['arming', 'armed', 'saving'].includes(state);
    this.archiveButton.hidden =
      !this.undoAvailable || state === 'saving' || state === 'armed' || state === 'arming';
  }

  setUndoAvailable(available: boolean): void {
    this.undoAvailable = available;
    this.archiveButton.hidden = !available;
  }

  setGhost(result: SearchResult | null): void {
    this.ghost.hidden = result === null;
    if (!result) return;
    try {
      const url = new URL(result.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        this.ghost.hidden = true;
        return;
      }
      this.ghostLink.href = url.href;
      this.ghostLink.textContent = result.capture.candidate.title;
      this.ghostText.textContent = result.excerpt.slice(0, 220);
    } catch {
      this.ghost.hidden = true;
    }
  }

  setHidden(hidden: boolean): void {
    this.host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
  }

  dispose(): void {
    this.host.remove();
  }
}
