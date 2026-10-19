export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element ${id}`);
  return found as T;
}
export function notice(message: string, kind: 'success' | 'error' | 'info' = 'info') {
  const box = element('message');
  box.textContent = message;
  box.className = `notice ${kind}`;
  box.hidden = false;
}
export async function busy(button: HTMLButtonElement, operation: () => Promise<void>) {
  button.disabled = true;
  try {
    await operation();
  } catch (error) {
    notice(error instanceof Error ? error.message : 'The operation could not complete.', 'error');
  } finally {
    button.disabled = false;
  }
}
