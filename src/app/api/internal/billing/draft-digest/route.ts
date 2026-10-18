import { getServiceClient } from '@/lib/api/supabase-service';
import { runDraftDigest } from '@/lib/billing/draft-digest';
import { cronAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily Vercel cron (vercel.json, 14:00 UTC = 7 am Phoenix): emails owners
 * and admins the invoice drafts made since the last run (retainer and
 * scheduled hours). The bell already announced each one as it was drafted;
 * this is the morning summary. 500 when the run broke, so the cron log shows it.
 */
export async function GET(request: Request) {
  const denied = cronAuthorization(request);
  if (denied) return denied;
  try {
    const result = await runDraftDigest(getServiceClient());
    return Response.json(result, { status: result.outcome === 'failed' ? 500 : 200, headers: privateHeaders });
  } catch (error) {
    console.error('[billing] draft digest failed', error);
    return Response.json({ outcome: 'failed' }, { status: 500, headers: privateHeaders });
  }
}
