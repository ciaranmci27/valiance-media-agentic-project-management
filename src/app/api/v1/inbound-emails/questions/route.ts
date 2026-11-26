import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/communications/agent-access';
import { waitingQuestions } from '@/lib/communications/agent-read';
import { handledParam, narrowToHandled } from '@/lib/communications/inbox-handlers';

export const dynamic = 'force-dynamic';

/**
 * Questions the agent asked that still wait on a person, across the key's
 * inboxes (or one), oldest first: each email's sender, subject, project, the
 * question and when it was asked. Answering one in the Inbox, or marking the
 * thread handled, takes it off. handled=me keeps only the inboxes the key's
 * member handles (as itself or through a group).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const inboxIds = await narrowToHandled(supabase, teamMemberId, await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id')), handledParam(searchParams));
  return success(await waitingQuestions(supabase, inboxIds));
}, { permission: 'inbound_email.read' });
