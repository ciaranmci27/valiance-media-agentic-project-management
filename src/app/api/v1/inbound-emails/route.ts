import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { badRequest } from '@/lib/api/errors';
import { assertUuid, inboxScope } from '@/lib/communications/agent-access';
import { listMessages } from '@/lib/communications/agent-read';
import { AGENT_MESSAGE_STATUSES } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * Inbox email, newest first, without bodies, from the inboxes the key's
 * member can read (or the one inbox_id names). Read only; nothing here sends.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  const status = searchParams.get('status');
  if (status && !(AGENT_MESSAGE_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be one of ${AGENT_MESSAGE_STATUSES.join(', ')}`);
  }
  const projectParam = searchParams.get('project_id');
  const projectId = projectParam ? assertUuid(projectParam, 'project_id') : null;
  const { data, total } = await listMessages(supabase, inboxIds, { status, projectId }, { offset, limit });
  return paginated(data, { page, limit, total });
}, { permission: 'inbound_email.read' });
