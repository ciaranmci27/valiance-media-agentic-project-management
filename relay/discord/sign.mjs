import { createHmac } from 'node:crypto';

/**
 * How the relay signs what it posts, the same scheme as the app's outgoing
 * webhooks: HMAC-SHA256 of "<unix seconds>.<raw body>" with the relay
 * secret, sent as X-PM-Relay-Signature: t=<seconds>,v1=<hex>. The app
 * refuses a request more than five minutes off, so the relay signs each
 * attempt afresh.
 */
export const SIGNATURE_HEADER = 'X-PM-Relay-Signature';

export function signatureHeader(secret, body, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}
