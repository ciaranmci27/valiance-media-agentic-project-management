import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { assertPersonCaller } from '@/lib/api/people-only';
import { undoAssistantAction } from '@/lib/api/assistant';
import { assistantUndoSchema, type AssistantUndo } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

/**
 * Takes back one thing the person's own assistant did, as My Assistant
 * does: kind task_created (the task goes to Trash), task_completed (the
 * task is reopened) or task_restore (a task it made comes back out of
 * Trash), with the task's id. Someone else's assistant's work reads as
 * missing (404). An inbox sort is undone with the Inbox's own undo (422
 * use_inbox_undo). Answers { undone: true, status? }.
 *
 * Permission: tasks.manage_assigned, on a person's own key.
 */
export const POST = withApi<AssistantUndo>(async ({ supabase, body, access, teamMemberId, apiKeyId }) => {
  assertPersonCaller(access);
  const result = await undoAssistantAction(supabase, teamMemberId, access, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/me/assistant/undo', entityType: 'task', entityId: body.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result, statusCode: 200 });
  return success(result);
}, { schema: assistantUndoSchema, permission: 'tasks.manage_assigned' });
