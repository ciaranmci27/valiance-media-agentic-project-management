import { runDispatch } from '@/lib/webhooks/dispatch';
import { internalAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';
import { getServiceClient } from '@/lib/api/supabase-service';
import { readSecret, savedInApp } from '@/lib/secrets/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Sends due webhook deliveries: retries whose backoff has passed, and leases a
 * crashed run left behind. Called by Supabase pg_cron (webhook_retry_kick,
 * every minute while something is due) with the scheduler secret: the one
 * "Turn on webhook retries" saved in the app, else WEBHOOK_SCHEDULER_SECRET.
 */
export async function POST(request: Request) {
  let saved: { secret: string | null; enabled: boolean } | null = null;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const service = getServiceClient();
      if (await savedInApp(service, 'webhook_scheduler_secret')) {
        saved = { secret: await readSecret(service, 'webhook_scheduler_secret'), enabled: true };
      }
    } catch {
      // The database is unreachable: fall back to the environment as before.
    }
  }
  const denied = internalAuthorization(request, 'scheduler', process.env, saved);
  if (denied) return denied;
  try { return Response.json(await runDispatch(), { headers: privateHeaders }); }
  catch (error) {
    console.error('[webhooks] scheduled dispatch failed', error);
    return Response.json({ error: 'Dispatcher unavailable. Delivery leases will expire safely.' }, { status: 503, headers: privateHeaders });
  }
}
