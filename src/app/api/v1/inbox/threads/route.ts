import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { listThreads } from '@/lib/communications/inbox-service';
import { INBOX_TABS } from '@/lib/communications/inbox-types';
import { isInboxTab } from '@/lib/communications/inbox-view';

export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;

/**
 * Conversations (threads), as the Inbox lists them: newest activity first,
 * from the inboxes the key's member reads (the same rule as the app, on the
 * api channel), with each tab's count. status is the tab (default all);
 * inbox_id, project_id, task_id and q narrow it. limit 1-200 (default 50),
 * offset from 0. The messages routes stay: these are the app's unit, a
 * conversation with its state, flags and projects.
 */
export const GET = withApi(async (ctx) => {
  const { searchParams } = ctx;
  const status = searchParams.get('status');
  if (status && !isInboxTab(status)) throw badRequest(`status must be one of ${INBOX_TABS.join(', ')}`);
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(searchParams.get('offset')) || 0, 0);
  return success(await inboxApi(() => listThreads(inboxContextOf(ctx), {
    inboxId: searchParams.get('inbox_id') || null,
    projectId: searchParams.get('project_id') || null,
    taskId: searchParams.get('task_id') || null,
    tab: isInboxTab(status) ? status : 'all',
    search: (searchParams.get('q') ?? '').slice(0, 200),
    limit,
    offset,
  })));
}, { permission: 'inbound_email.read' });
