import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { myAssistantActivity } from '@/lib/api/assistant';

export const dynamic = 'force-dynamic';

/**
 * What the person's own assistant did in the last 30 days, newest first,
 * as My Assistant lists it: each line with its undo when one exists, and
 * its reply drafts ready for the person. Answers { items, drafts }. 404
 * when they have no assistant.
 *
 * Permission: tasks.read, on a person's own key.
 */
export const GET = withApi(async ({ supabase, access, teamMemberId }) => {
  assertPersonCaller(access);
  return success(await myAssistantActivity(supabase, teamMemberId, access));
}, { permission: 'tasks.read' });
