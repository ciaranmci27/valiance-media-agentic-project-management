import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/inbound-email/agent-access';
import { waitingQuestions } from '@/lib/inbound-email/agent-read';

export const dynamic = 'force-dynamic';

/**
 * Questions the agent asked that still wait on a person, across the key's
 * inboxes (or one), oldest first: each email's sender, subject, project, the
 * question and when it was asked. Answering one in the Inbox, or marking the
 * thread handled, takes it off.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  return success(await waitingQuestions(supabase, inboxIds));
}, { permission: 'inbound_email.read' });
