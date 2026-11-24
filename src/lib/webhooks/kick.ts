import { afterResponse } from '@/lib/api/after-response';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import { runDispatch } from './dispatch';

/**
 * After a server write, sends what it queued (task, comment, question,
 * suggestion, review or invoice events) once the response is out, so an
 * agent harness hears about it right away instead of at the next retry run.
 * The database decides what was queued; with nothing due the run is one
 * claim that comes back empty. Skipped while Webhooks is off.
 */
export function kickWebhooks(access: AccessContext | null | undefined): void {
  if (!access || !isModuleEnabled(access, 'webhooks')) return;
  afterResponse('webhook dispatch', () => runDispatch());
}
