import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest, forbidden } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';
import { canDeleteReminder, loadReminder, REMINDER_SELECT, updateReminderSchema } from '@/lib/api/reminders';

export const GET = withApi(async ({ supabase, params, teamMemberId, access }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to read reminders');
  return success(await loadReminder(supabase, access, teamMemberId, (params as { id: string }).id));
}, { permission: 'reminders.manage_own' });

/**
 * Change a reminder's text, notes, date or time, or tick it off (status
 * done) and reopen it. A reminder with its date removed loses its time too.
 */
export const PATCH = withApi(async ({ supabase, params, body, teamMemberId, access, apiKeyId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to write reminders');
  const id = (params as { id: string }).id;
  const before = await loadReminder(supabase, access, teamMemberId, id);
  const input = body as z.infer<typeof updateReminderSchema>;

  // Removing the date removes its time with it; a time alone needs a date.
  const remindOn = input.remind_on !== undefined ? input.remind_on : before.remind_on;
  const remindAt = input.remind_on === null ? null : input.remind_at !== undefined ? input.remind_at : before.remind_at;
  if (remindAt && !remindOn) throw badRequest('A time needs a date (remind_on)');

  const patch: Record<string, unknown> = { ...input };
  if (input.remind_on === null) patch.remind_at = null;
  // The service client has no signed-in member, so who ticked it off is set here.
  if (input.status === 'done' && before.status !== 'done') patch.completed_by = teamMemberId;

  const { data, error } = await supabase.from('reminders').update(patch).eq('id', id).is('deleted_at', null).select(REMINDER_SELECT).single();
  if (error) throw error;

  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/reminders/${id}`, entityType: 'reminder', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateReminderSchema, permission: 'reminders.manage_own' });

export const DELETE = withApi(async ({ supabase, params, teamMemberId, access, apiKeyId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to write reminders');
  const id = (params as { id: string }).id;
  const before = await loadReminder(supabase, access, teamMemberId, id);
  if (!canDeleteReminder(access, teamMemberId, before)) {
    throw forbidden('Only the reminder\'s owner, its writer or a task manager can delete it; tick it off instead');
  }
  await trashForApi(supabase, 'reminders', id, teamMemberId, 'Reminder');

  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/reminders/${id}`, entityType: 'reminder', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
}, { permission: 'reminders.manage_own' });
