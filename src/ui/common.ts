export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element ${id}`);
  return found as T;
}
/**
 * A success goes after six seconds. Info says what is still under way and an error what
 * to act on, so they stay until the next notice replaces them.
 */
const successMs = 6_000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let noticeRoom: ResizeObserver | undefined;
let focusClearing = false;
/** Whether the last press was a pointer's rather than a key's. */
let pointerFocus = false;
/**
 * Keyboard focus that lands under the toast moves up clear of it. Chrome scrolls a control
 * into view only when it is outside the window, not when the toast covers it. Focus from a
 * pointer press is left alone, text fields included (Chrome counts their mouse focus as
 * visible), so a click or a drag never moves out from under the pointer.
 */
function clearFocus(event: FocusEvent): void {
  const target = event.target;
  if (pointerFocus || !(target instanceof Element)) return;
  requestAnimationFrame(() => {
    const box = document.getElementById('message');
    if (!box || box.hidden || !target.matches(':focus-visible')) return;
    const toast = box.getBoundingClientRect();
    const focused = target.getBoundingClientRect();
    // Never past the control's own top, so a tall one keeps its start in view.
    const lift = Math.min(focused.bottom - toast.top + 16, focused.top - 16);
    if (
      lift > 0 &&
      focused.bottom > toast.top &&
      focused.top < toast.bottom &&
      focused.left < toast.right &&
      focused.right > toast.left
    )
      window.scrollBy({ top: lift, behavior: 'instant' });
  });
}
export function notice(message: string, kind: 'success' | 'error' | 'info' = 'info') {
  const box = element('message');
  box.textContent = message;
  box.className = `notice ${kind}`;
  box.hidden = false;
  // The toast floats over the page's end, so the page makes room below it for the
  // toast's height (ui.css) and its end can always scroll clear. The room outlasts the
  // toast, so its going moves nothing; the next notice measures it again.
  box.dataset.room = '';
  const room = () => {
    if (!box.hidden)
      document.documentElement.style.setProperty('--notice-room', `${box.offsetHeight}px`);
  };
  room();
  noticeRoom ??= new ResizeObserver(room);
  noticeRoom.observe(box);
  if (!focusClearing) {
    focusClearing = true;
    document.addEventListener(
      'pointerdown',
      () => {
        pointerFocus = true;
      },
      true,
    );
    document.addEventListener(
      'keydown',
      () => {
        pointerFocus = false;
      },
      true,
    );
    document.addEventListener('focusin', clearFocus);
  }
  // A new notice replaces the last, and its kind decides whether it goes by itself.
  clearTimeout(noticeTimer);
  if (kind === 'success')
    noticeTimer = setTimeout(() => {
      box.hidden = true;
    }, successMs);
}
/** Runs an operation with its button, or every button that would race it, disabled. */
export async function busy(
  button: HTMLButtonElement,
  operation: () => Promise<void>,
): Promise<void>;
export async function busy(
  buttons: readonly HTMLButtonElement[],
  operation: () => Promise<void>,
): Promise<void>;
export async function busy(
  buttons: HTMLButtonElement | readonly HTMLButtonElement[],
  operation: () => Promise<void>,
): Promise<void> {
  const held = buttons instanceof HTMLButtonElement ? [buttons] : buttons;
  // An error stands until something replaces it, and a new action starts without it,
  // even one that succeeds without a notice of its own.
  const standing = document.getElementById('message');
  if (standing?.classList.contains('error')) standing.hidden = true;
  for (const button of held) button.disabled = true;
  try {
    await operation();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'The operation could not complete.', 'error');
  } finally {
    for (const button of held) button.disabled = false;
  }
}
