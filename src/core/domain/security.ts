export function publicMediaUrl(raw: string): URL {
  if (raw.length > 4096) throw new Error('Media URL too long');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('Only public HTTPS media without credentials is supported');
  const host = url.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host.endsWith('.') ||
    host.includes('*') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.test') ||
    host.includes(':') ||
    /^\d+(?:\.\d+){3}$/.test(host) ||
    host === 'localhost'
  )
    throw new Error('Local or IP media destinations are not permitted');
  return url;
}
export function boundedMessage(message: unknown, maxBytes = 400000): boolean {
  try {
    return JSON.stringify(message).length <= maxBytes;
  } catch {
    return false;
  }
}
