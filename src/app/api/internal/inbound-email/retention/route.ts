import { getServiceClient } from '@/lib/api/supabase-service';
import { runRetention } from '@/lib/inbound-email/retention';
import { cronAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily Vercel cron (vercel.json): deletes inbound email past each inbox's
 * retention_days and messages stuck in receiving, files first, then rows.
 * 500 when the run itself broke, so the cron log shows it; a partial run
 * (some files failed, or more left than one run handles) is 200 and resumes
 * next time.
 */
export async function GET(request: Request) {
  const denied = cronAuthorization(request);
  if (denied) return denied;
  const summary = await runRetention(getServiceClient());
  return Response.json(summary, { status: summary.outcome === 'failed' ? 500 : 200, headers: privateHeaders });
}
