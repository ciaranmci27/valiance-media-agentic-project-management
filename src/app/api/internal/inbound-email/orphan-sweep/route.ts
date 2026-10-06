import { getServiceClient } from '@/lib/api/supabase-service';
import { runOrphanSweep } from '@/lib/inbound-email/retention';
import { cronAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Weekly Vercel cron (vercel.json): deletes every object in the inbound-email
 * bucket that no message or attachment row owns. 500 when the run broke.
 */
export async function GET(request: Request) {
  const denied = cronAuthorization(request);
  if (denied) return denied;
  const summary = await runOrphanSweep(getServiceClient());
  return Response.json(summary, { status: summary.outcome === 'failed' ? 500 : 200, headers: privateHeaders });
}
