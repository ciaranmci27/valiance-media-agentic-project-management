import { myAssistantView, updateMyAssistant } from '@/lib/api/assistant';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { updateMyAssistantSchema } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

/**
 * The signed-in person's own assistant, as My Assistant shows it: whether
 * assistants are on and what the workspace calls them, the assistant's
 * state (working, paused by them, getting ready, broken) and settings, and
 * the chat connections they can link. A broken assistant's admins are told
 * (once a day). Any signed-in member; assistant is null when they have none.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, ({ service, memberId, access }) => myAssistantView(service, memberId, access), { noStore: true });
}

/**
 * Changes the person's own assistant: name, tone, personality, avatar_tone,
 * switches (sort_inbox, create_tasks, draft_replies, remind_me), paused.
 * Resuming an assistant an admin paused is refused (paused_by_admin).
 * Answers the page's view again.
 */
export async function PATCH(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }) => {
    const body = await readWorkspaceBody(request, updateMyAssistantSchema);
    return updateMyAssistant(service, memberId, access, body);
  }, { noStore: true });
}
