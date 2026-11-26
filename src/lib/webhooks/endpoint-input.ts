import { blockedAddressReason, isBlockedHostName, privateTargetsAllowed } from './address';

/**
 * What a webhook endpoint's URL must be, shared by Settings > Developers and
 * the v1 API (/api/v1/webhook-endpoints) so both refuse the same addresses:
 * HTTPS to a public host. localhost, metadata names and literal private
 * addresses are refused here; a name that resolves to one is refused when a
 * delivery is sent (lib/webhooks/target.ts). Where private targets are
 * allowed (local development, WEBHOOKS_ALLOW_PRIVATE_TARGETS=true), plain
 * http on localhost works too, as before.
 */

const LOCALHOST_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Null when the URL is fine, else the plain reason it is refused. */
export function webhookUrlError(raw: string, env: Record<string, string | undefined> = process.env): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Enter a valid URL';
  }
  const allowPrivate = privateTargetsAllowed(env);
  const isLocalhost = LOCALHOST_NAMES.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost && allowPrivate)) {
    return 'Endpoint URL must use HTTPS';
  }
  if (!allowPrivate) {
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isBlockedHostName(host)) return 'Endpoint URL must be a public address, not localhost or a metadata host';
    const reason = blockedAddressReason(host);
    if (reason) return `Endpoint URL must be a public address, not a ${reason} one`;
  }
  return null;
}
