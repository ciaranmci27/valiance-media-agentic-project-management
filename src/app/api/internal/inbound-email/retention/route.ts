import { getServiceClient } from '@/lib/api/supabase-service';
import { runRetention } from '@/lib/communications/retention';
import { expireWaiting } from '@/lib/communications/plans';
import { cronAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily Vercel cron (vercel.json): deletes inbound email past each inbox's
 * retention_days and messages stuck in receiving, files first, then rows.
 * 500 when the run itself broke, so the cron log shows it; a partial run
 * (some files failed, or more left than one run handles) is 200 and resumes
 * next time. Then lapses triage proposals, questions and replies owed that
 * have waited too long.
 */
export async function GET(request: Request) {
  const denied = cronAuthorization(request);
  if (denied) return denied;
  const service = getServiceClient();
  const summary = await runRetention(service);
  try {
    Object.assign(summary, { expired: await expireWaiting(service) });
  } catch (error) {
    console.error('[inbound-email] expiring waiting triage failed:', error);
  }
  return Response.json(summary, { status: summary.outcome === 'failed' ? 500 : 200, headers: privateHeaders });
}
