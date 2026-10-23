export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element ${id}`);
  return found as T;
}
/** How long a notice stays: long enough to read, and longer for an error to act on. */
const noticeMs = { success: 6_000, info: 6_000, error: 15_000 } as const;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let noticeRoom: ResizeObserver | undefined;
export function notice(message: string, kind: 'success' | 'error' | 'info' = 'info') {
  const box = element('message');
  box.textContent = message;
  box.className = `notice ${kind}`;
  box.hidden = false;
  // The toast floats over the page's end, so the page makes room below it for the
  // toast's height (ui.css) and its end can always scroll clear.
  const room = () =>
    document.documentElement.style.setProperty('--notice-room', `${box.offsetHeight}px`);
  room();
  noticeRoom ??= new ResizeObserver(room);
  noticeRoom.observe(box);
  // A new notice replaces the last and restarts the clock.
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    box.hidden = true;
  }, noticeMs[kind]);
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
