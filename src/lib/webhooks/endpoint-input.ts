/**
 * What a webhook endpoint's URL must be, shared by Settings > Developers and
 * the v1 API (/api/v1/webhook-endpoints) so both refuse the same addresses:
 * HTTPS, or plain http on localhost for local development.
 */

const LOCALHOST_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Null when the URL is fine, else the plain reason it is refused. */
export function webhookUrlError(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Enter a valid URL';
  }
  const isLocalhost = LOCALHOST_NAMES.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    return 'Endpoint URL must use HTTPS';
  }
  return null;
}
