import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { deleteSchedule, getSchedule, updateSchedule } from '@/lib/api/schedules';
import { scheduleUpdateSchema, type ScheduleUpdateInput } from '@/lib/schedules';

/** One schedule with its next date and the five dates from it. Permission: tasks.read or tasks.create. */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await getSchedule(supabase, { memberId: teamMemberId, access, scopes }, params.id)), { permission: ['tasks.read', 'tasks.create', 'templates.manage'] });

/**
 * Changes a schedule: only what is sent. status paused pauses it; active
 * resumes it from today (missed dates are not made). A change to what it
 * makes is checked like a run and makes the key's member its runner.
 * Permission: whoever set it up or may change its template (a task repeat:
 * whoever may edit the task), with tasks.create.
 */
export const PATCH = withApi<ScheduleUpdateInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const schedule = await updateSchedule(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/schedules/${params.id}`, entityType: 'schedule', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: schedule, statusCode: 200 });
  return success(schedule);
}, { schema: scheduleUpdateSchema, permission: 'tasks.create', idempotentPatch: true });

/** Removes a schedule: it never runs again; what it made stays. Permission: as for changing it. */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const schedule = await deleteSchedule(supabase, { memberId: teamMemberId, access, scopes }, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/schedules/${params.id}`, entityType: 'schedule', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: schedule, statusCode: 200 });
  return success({ id: params.id, deleted: true });
}, { permission: 'tasks.create' });
