import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { clearTaskRepeat, getTaskRepeat, setTaskRepeat } from '@/lib/api/schedules';
import { taskRepeatSchema, type TaskRepeatInput } from '@/lib/schedules';

/** The task's repeat (a schedule of kind task), or null. Permission: tasks.read. */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await getTaskRepeat(supabase, { memberId: teamMemberId, access, scopes }, params.id)), { permission: 'tasks.read' });

/**
 * Sets or replaces the task's repeat. Copies are due on the recurrence's
 * dates, counted from the task's due date (a task without one gets the
 * first date on or after today). mode schedule (default): the next copy is
 * made when this one falls due; after_done: when it is completed. Each copy
 * keeps the title, description, assignees, initiative, tags and priority,
 * with its subtasks unchecked. Answers { repeat, due_date, due_date_set }.
 * Permission: editing the task (tasks.manage_assigned on your own, or
 * tasks.manage_all) and tasks.create.
 */
export const PUT = withApi<TaskRepeatInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await setTaskRepeat(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'PUT', endpoint: `/api/v1/tasks/${params.id}/repeat`, entityType: 'schedule', entityId: result.repeat.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result.repeat, statusCode: 200 });
  return success(result);
}, { schema: taskRepeatSchema, permission: 'tasks.manage_assigned' });

/** Stops the task repeating. Copies already made stay. Permission: as for setting it. */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await clearTaskRepeat(supabase, { memberId: teamMemberId, access, scopes }, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${params.id}/repeat`, entityType: 'schedule', entityId: params.id, apiKeyId, teamMemberId, statusCode: 200 });
  return success(result);
}, { permission: 'tasks.manage_assigned' });
