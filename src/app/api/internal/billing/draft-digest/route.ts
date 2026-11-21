import { getServiceClient } from '@/lib/api/supabase-service';
import { runDraftDigest } from '@/lib/billing/draft-digest';
import { cronAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';
import { moduleEnabled } from '@/lib/modules/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily Vercel cron (vercel.json, 14:00 UTC = 7 am Phoenix): emails owners
 * and admins the invoice drafts made since the last run (retainer and
 * scheduled hours). The bell already announced each one as it was drafted;
 * this is the morning summary. 500 when the run broke, so the cron log shows it.
 * With Billing and finance switched off (or its state unreadable) it sends
 * nothing and still answers 200: an idle module is not a broken run.
 */
export async function GET(request: Request) {
  const denied = cronAuthorization(request);
  if (denied) return denied;
  try {
    const service = getServiceClient();
    if (!(await moduleEnabled(service, 'billing'))) {
      return Response.json({ drafts: 0, recipients: 0, emailed: 0, outcome: 'module_off' }, { headers: privateHeaders });
    }
    const result = await runDraftDigest(service);
    return Response.json(result, { status: result.outcome === 'failed' ? 500 : 200, headers: privateHeaders });
  } catch (error) {
    console.error('[billing] draft digest failed', error);
    return Response.json({ outcome: 'failed' }, { status: 500, headers: privateHeaders });
  }
}
