import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { listThreads } from '@/lib/inbound-email/inbox-service';
import { isInboxTab } from '@/lib/inbound-email/inbox-view';

export const dynamic = 'force-dynamic';

const MAX_THREAD_LIMIT = 1000;

/** Threads for the Inbox list: newest activity first, filtered and paged. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const tab = params.get('status');
  // A quiet refresh re-reads every page already on screen in one request.
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), MAX_THREAD_LIMIT);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);
  return inboxRoute((ctx) => listThreads(ctx, {
    inboxId: params.get('inbox_id') || null,
    projectId: params.get('project_id') || null,
    tab: isInboxTab(tab) ? tab : 'all',
    search: (params.get('q') ?? '').slice(0, 200),
    limit,
    offset,
  }));
}
