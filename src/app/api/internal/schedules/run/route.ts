import { internalAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';
import { getServiceClient } from '@/lib/api/supabase-service';
import { readSecret, savedInApp } from '@/lib/secrets/store';
import { runDueSchedules } from '@/lib/api/schedules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Runs due schedules: recurring templates and repeating tasks, and a failed
 * occurrence once more. Called by Supabase pg_cron (pm.schedules_kick,
 * every 5 minutes while something is due) with the app's scheduler secret:
 * the one saved in the app (webhook retries set it up, and so does setting
 * up a schedule), else WEBHOOK_SCHEDULER_SECRET.
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
      // The database is unreachable: fall back to the environment.
    }
  }
  const denied = internalAuthorization(request, 'scheduler', process.env, saved);
  if (denied) return denied;
  try { return Response.json(await runDueSchedules(getServiceClient()), { headers: privateHeaders }); }
  catch (error) {
    console.error('[schedules] scheduled run failed', error);
    return Response.json({ error: 'Scheduler unavailable. Due schedules run on the next call.' }, { status: 503, headers: privateHeaders });
  }
}
