import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { myAssistantView, updateMyAssistant } from '@/lib/api/assistant';
import { updateMyAssistantSchema, type UpdateMyAssistant } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

/**
 * The key's person's own assistant, as My Assistant shows it: whether
 * assistants are on and what the workspace calls them, agents_on, the
 * assistant (state, reason, host_down, who fixes it, preferences) or null
 * when they have none, and the chat connections they can link. A person's
 * own key or connected AI tool; an agent has no assistant of its own (403
 * people_only). A broken assistant's admins are told, once a day, as in
 * the app.
 *
 * Permission: tasks.read, on a person's own key.
 */
export const GET = withApi(async ({ supabase, access, teamMemberId }) => {
  assertPersonCaller(access);
  return success(await myAssistantView(supabase, teamMemberId, access));
}, { permission: 'tasks.read' });

/**
 * Changes the person's own assistant: name, tone, personality, avatar_tone,
 * switches (sort_inbox, create_tasks, draft_replies, remind_me, remember),
 * paused. Resuming an assistant an admin paused is refused (403
 * paused_by_admin). Answers the view again.
 *
 * Permission: tasks.manage_assigned, on a person's own key.
 */
export const PATCH = withApi<UpdateMyAssistant>(async ({ supabase, body, access, teamMemberId, apiKeyId }) => {
  assertPersonCaller(access);
  return success(await updateMyAssistant(supabase, teamMemberId, access, body, { endpoint: '/api/v1/me/assistant', apiKeyId }));
}, { schema: updateMyAssistantSchema, permission: 'tasks.manage_assigned' });
