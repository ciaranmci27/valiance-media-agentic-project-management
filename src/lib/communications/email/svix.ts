import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix webhook signatures, as Resend signs its webhooks
 * (https://resend.com/docs/webhooks/verify-webhooks-requests, manual steps at
 * https://docs.svix.com/receiving/verifying-payloads/how-manual):
 * HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`, keyed with the
 * base64 part of the `whsec_` secret, base64 encoded; `svix-signature` holds
 * space-separated `v1,<signature>` entries, any of which may match. The
 * timestamp must be within five minutes. Implemented here rather than adding
 * the svix SDK: it is a few lines on node:crypto.
 */

export const SVIX_TOLERANCE_SECONDS = 300;

function secretKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
}

export function signSvix(secret: string, id: string, timestamp: number | string, body: string): string {
  const digest = createHmac('sha256', secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${digest}`;
}

export function verifySvixSignature(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, body } = input;
  if (!secret || !id || !timestamp || !signature) return false;
  if (id.length > 200 || timestamp.length > 20 || signature.length > 2048) return false;
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(seconds)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - seconds) > SVIX_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signSvix(secret, id, timestamp, body).slice(3), 'base64');
  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
