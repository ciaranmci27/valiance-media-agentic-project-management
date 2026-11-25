import { undoAssistantAction } from '@/lib/api/assistant';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { assistantUndoSchema } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

/**
 * Takes back one thing the person's own assistant did: kind task_created
 * (the task goes to Trash) or task_completed (the task is reopened), with
 * the task's id. Someone else's assistant's work reads as missing. An inbox
 * sort is undone with POST /api/workspace/inbox/plans/{id}/undo.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }) => {
    const body = await readWorkspaceBody(request, assistantUndoSchema);
    return undoAssistantAction(service, memberId, access, body);
  });
}
