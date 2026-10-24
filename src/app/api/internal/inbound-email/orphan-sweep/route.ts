import { getServiceClient } from '@/lib/api/supabase-service';
import { runOrphanSweep } from '@/lib/inbound-email/retention';
import { sweepAbandonedUploads } from '@/lib/task-files/retention';
import { cronAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Weekly Vercel cron (vercel.json): deletes every object in the inbound-email
 * bucket that no message, attachment or stored copy owns, then task file
 * uploads abandoned before they were added (task_uploads). 500 when either
 * run broke.
 */
export async function GET(request: Request) {
  const denied = cronAuthorization(request);
  if (denied) return denied;
  const supabase = getServiceClient();
  const summary = await runOrphanSweep(supabase);
  const taskUploads = await sweepAbandonedUploads(supabase);
  const line = JSON.stringify({ event: 'task_files.abandoned_uploads', ...taskUploads });
  if (taskUploads.outcome === 'failed') console.error(line);
  else console.log(line);
  const failed = summary.outcome === 'failed' || taskUploads.outcome === 'failed';
  return Response.json({ ...summary, task_uploads: taskUploads }, { status: failed ? 500 : 200, headers: privateHeaders });
}
