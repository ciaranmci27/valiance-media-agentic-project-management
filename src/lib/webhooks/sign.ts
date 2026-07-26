// Webhook signing (Stripe-style HMAC-SHA256 over "<timestamp>.<body>").
//
// The signature header is `X-VM-Signature: t=<unix>,v1=<hex>`. Consumers
// recompute the HMAC over `${t}.${rawBody}` with the endpoint secret and
// compare in constant time, rejecting stale timestamps to block replay.
// See app/WEBHOOKS.md for the consumer-side verification recipe.

export const WEBHOOK_SIGNATURE_HEADER = 'X-VM-Signature';

/** Signing secret shown once on endpoint creation. Prefix mirrors `pk_live_`. */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    'whsec_' +
    Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Returns the full header value `t=<unix>,v1=<hex>` for `body`. */
export async function buildSignatureHeader(
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${timestampSeconds}.${body}`);
  return `t=${timestampSeconds},v1=${v1}`;
}

/** Constant-time hex string comparison (equal length assumed after parse). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verify a received signature header against the raw body. Provided for
 * self-tests and any in-repo consumer; the admin receiver ships its own copy.
 */
export async function verifySignatureHeader(
  secret: string,
  header: string | null | undefined,
  body: string,
  toleranceSeconds = 300,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  return timingSafeEqualHex(expected, v1);
}
