import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/inbound-email/agent-access';

export const dynamic = 'force-dynamic';

/**
 * For the batched summary: the newest triage of each email that has not
 * been summarized yet, oldest first, with sender, subject, project and
 * linked tasks (no bodies). superseded_triage_ids lists older unsummarized
 * triage of the same email, which mark-summarized clears too.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  const inboxIds = await inboxScope(supabase, teamMemberId, searchParams.get('inbox_id'));
  if (inboxIds.length === 0) return success([]);
  const { data, error } = await supabase.rpc('email_unsummarized_triage', { p_inbox_ids: inboxIds, p_limit: 200 });
  if (error) throw error;
  return success(data ?? []);
}, { permission: 'inbound_email.read' });
