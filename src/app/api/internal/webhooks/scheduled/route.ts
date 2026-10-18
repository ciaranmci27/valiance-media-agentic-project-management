import { runDispatch } from '@/lib/webhooks/dispatch';
import { internalAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Sends due webhook deliveries: retries whose backoff has passed, and leases a
 * crashed run left behind. Called by Supabase pg_cron (webhook_retry_kick,
 * every minute while something is due) with WEBHOOK_SCHEDULER_SECRET.
 */
export async function POST(request: Request) {
  const denied = internalAuthorization(request, 'scheduler');
  if (denied) return denied;
  try { return Response.json(await runDispatch(), { headers: privateHeaders }); }
  catch (error) {
    console.error('[webhooks] scheduled dispatch failed', error);
    return Response.json({ error: 'Dispatcher unavailable. Delivery leases will expire safely.' }, { status: 503, headers: privateHeaders });
  }
}
