import { afterResponse } from '@/lib/api/after-response';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { getServiceClient } from '@/lib/api/supabase-service';
import { runDispatch } from './dispatch';
import { ensureWebhookRetries } from './retries';

/**
 * After a server write, sends what it queued (task, comment, question,
 * suggestion, review or invoice events) once the response is out, so an
 * agent harness hears about it right away instead of at the next retry run.
 * The database decides what was queued; with nothing due the run is one
 * claim that comes back empty. Skipped while Webhooks is off. A delivery
 * that failed and waits for a retry turns retries on by themselves, if
 * nobody turned them off and they can run.
 */
export function kickWebhooks(access: AccessContext | null | undefined): void {
  if (!access || !isModuleEnabled(access, 'webhooks')) return;
  afterResponse('webhook dispatch', async () => {
    const summary = await runDispatch();
    if (summary.retrying > 0) await ensureWebhookRetries(getServiceClient());
  });
}
