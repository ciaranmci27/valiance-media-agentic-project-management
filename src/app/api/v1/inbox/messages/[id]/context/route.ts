import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { loadAccessibleMessage } from '@/lib/communications/agent-access';
import { triageContext } from '@/lib/communications/triage-context';

export const dynamic = 'force-dynamic';

/**
 * Everything a triage agent reads before planning a message: the message,
 * who is speaking and how it reached us, what earlier plans on the
 * conversation did, what is owed or asked, and each project in scope with its
 * open tasks and recent plan items. mode=shadow leaves out what this message
 * already caused, for a shadow triage running after the old one.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams, teamMemberId, access }) => {
  const mode = searchParams.get('mode') ?? 'live';
  if (mode !== 'live' && mode !== 'shadow') throw badRequest('mode must be live or shadow');
  const message = await loadAccessibleMessage(supabase, teamMemberId, access, params.id);
  return success(await triageContext(supabase, message, mode));
}, { permission: 'inbound_email.read' });
