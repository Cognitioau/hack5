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
  for (const button of held) button.disabled = true;
  try {
    await operation();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'The operation could not complete.', 'error');
  } finally {
    for (const button of held) button.disabled = false;
  }
}
