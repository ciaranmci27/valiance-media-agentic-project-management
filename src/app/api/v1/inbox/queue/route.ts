import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { inboxScope } from '@/lib/communications/agent-access';
import { triageQueue } from '@/lib/communications/triage-context';

export const dynamic = 'force-dynamic';

/**
 * The messages a triage job plans next, oldest first: mode=plans, new mail in
 * plan inboxes once its conversation has been quiet a few minutes; mode=shadow,
 * mail in shadow inboxes the old triage handled and no shadow plan covers yet.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const mode = searchParams.get('mode') ?? 'plans';
  if (mode !== 'plans' && mode !== 'shadow') throw badRequest('mode must be plans or shadow');
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 20) || 20, 1), 100);
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  return success({ mode, messages: await triageQueue(supabase, inboxIds, mode, limit) });
}, { permission: 'inbound_email.read' });
