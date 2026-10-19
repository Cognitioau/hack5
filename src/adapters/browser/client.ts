import type { AppResponse, TrustedMessage } from '../../core/contracts';
export async function command(
  message: TrustedMessage,
): Promise<Extract<AppResponse, { ok: true }>> {
  const response = (await chrome.runtime.sendMessage(message)) as AppResponse | undefined;
  if (!response) throw new Error('The extension is restarting. Try again.');
  if (!response.ok) throw new Error(response.error);
  return response;
}
