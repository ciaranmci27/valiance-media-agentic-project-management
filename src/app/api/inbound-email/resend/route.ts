import { getServiceClient } from '@/lib/api/supabase-service';
import { ingestInbound } from '@/lib/inbound-email/ingest';
import { createResendReceiving, inboundFromResend, type ResendWebhookEvent } from '@/lib/inbound-email/resend';
import { verifySvixSignature } from '@/lib/inbound-email/svix';
import { privateHeaders, readCappedJsonText } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Webhook bodies are metadata only; the email itself is fetched from Resend. */
const MAX_WEBHOOK_BYTES = 262_144;

function respond(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
}

/**
 * Resend's `email.received` webhook, Svix-signed with
 * RESEND_INBOUND_WEBHOOK_SECRET. Reads the full message through Resend's
 * Receiving API (RESEND_API_KEY, GET requests only), copies its files into
 * the private bucket server-side and files it in the matching inboxes.
 * 2xx means done (or nothing to do: another event type, or no inbox for the
 * recipients, which stores nothing). Any failure answers 5xx so Resend
 * retries; ingestion is idempotent, so a retry never duplicates rows or files.
 */
export async function POST(request: Request) {
  const env = process.env;
  if (env.NEXT_PUBLIC_DEMO_MODE === 'true' || env.DEMO_MODE === 'true') {
    return respond({ error: 'Inbound email is disabled' }, 404);
  }
  const secret = env.RESEND_INBOUND_WEBHOOK_SECRET;
  const apiKey = env.RESEND_API_KEY;
  if (!secret || !secret.startsWith('whsec_') || !apiKey || !env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) {
    return respond({ error: 'Inbound email is not configured' }, 503);
  }

  let body: string;
  try {
    body = await readCappedJsonText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    const tooLarge = (error as Error).message === 'Request is too large';
    return respond({ error: tooLarge ? 'Request is too large' : 'Send an application/json body' }, tooLarge ? 413 : 400);
  }
  const signed = verifySvixSignature({
    secret,
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
    body,
  });
  if (!signed) return respond({ error: 'Invalid signature' }, 401);

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(body) as ResendWebhookEvent;
  } catch {
    return respond({ error: 'Invalid JSON' }, 400);
  }
  if (event.type !== 'email.received') return respond({ status: 'ignored', reason: 'event_type' });
  const emailId = event.data?.email_id;
  if (typeof emailId !== 'string' || !emailId || emailId.length > 200) {
    return respond({ error: 'email.received without data.email_id' }, 400);
  }

  try {
    const client = createResendReceiving({ apiKey });
    const inbound = await inboundFromResend(client, emailId, event.data ?? null);
    const result = await ingestInbound(getServiceClient(), inbound);
    if (result.kind === 'no_inbox') return respond({ status: 'ignored', reason: 'no_inbox' });
    return respond({ status: 'ingested', inboxes: result.inboxes });
  } catch (error) {
    console.error(`[inbound-email] Resend email ${emailId} failed`, error);
    return respond({ error: 'Could not take in the email. Retry later.' }, 500);
  }
}
