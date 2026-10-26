import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import {
  createReminder,
  createReminderSchema,
  REMINDER_SELECT,
  visibleReminderFilter,
} from '@/lib/api/reminders';
import { postgrestList, trashedProjectIds } from '@/lib/supabase/trash';
import type { SupabaseClient } from '@supabase/supabase-js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tasks in Trash that still have reminders. Only these need leaving out: a
 * reminder on a task in a project in Trash carries that project id, which the
 * project filter covers. Bounded by reminders, not by everything in Trash.
 */
async function trashedTasksWithReminders(supabase: SupabaseClient): Promise<string[]> {
  // includes-deleted: finds the reminders' tasks that are in Trash
  const { data, error } = await supabase
    .from('reminders')
    .select('task_id, task:tasks!inner(id)')
    .is('deleted_at', null)
    .not('task.deleted_at', 'is', null);
  if (error) throw error;
  return [...new Set((data || []).map((row: { task_id: string }) => row.task_id))];
}

/**
 * Reminders the key's member can see, open first by default. Filters:
 * status (open | done | all), owner (me | anyone), task_id, project_id,
 * due_by (YYYY-MM-DD: dated on or before it, for "what is due").
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to read reminders');
  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status') ?? 'open';
  const owner = searchParams.get('owner') ?? 'anyone';
  const taskId = searchParams.get('task_id');
  const projectId = searchParams.get('project_id');
  const dueBy = searchParams.get('due_by');
  if (!['open', 'done', 'all'].includes(status)) throw badRequest('status must be open, done or all');
  if (!['me', 'anyone'].includes(owner)) throw badRequest('owner must be me or anyone');
  if (taskId && !uuid.test(taskId)) throw badRequest('task_id must be a uuid');
  if (projectId && !uuid.test(projectId)) throw badRequest('project_id must be a uuid');
  if (dueBy && !day.test(dueBy)) throw badRequest('due_by must be YYYY-MM-DD');

  let query = supabase
    .from('reminders')
    .select(REMINDER_SELECT, { count: 'exact' })
    .or(visibleReminderFilter(access, teamMemberId))
    .is('deleted_at', null);
  // A reminder on a task or project in Trash went to Trash with it.
  const trashedProjects = await trashedProjectIds(supabase);
  if (trashedProjects.length) query = query.or(`project_id.is.null,project_id.not.in.${postgrestList(trashedProjects)}`);
  const trashedTasks = await trashedTasksWithReminders(supabase);
  if (trashedTasks.length) query = query.or(`task_id.is.null,task_id.not.in.${postgrestList(trashedTasks)}`);
  if (status !== 'all') query = query.eq('status', status);
  if (owner === 'me') query = query.eq('owner_id', teamMemberId);
  if (taskId) query = query.eq('task_id', taskId);
  if (projectId) query = query.eq('project_id', projectId);
  if (dueBy) query = query.lte('remind_on', dueBy);

  const { data, count, error } = await query
    .order('remind_on', { ascending: true, nullsFirst: false })
    .order('remind_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: 'reminders.manage_own' });

/**
 * Write a reminder: on a task, on a project, or standalone. It is the
 * caller's unless owner_id names someone (agents and task managers only).
 */
export const POST = withApi(async ({ supabase, body, teamMemberId, access, apiKeyId }) => {
  if (!teamMemberId) throw badRequest('API key must be linked to a team member to write reminders');
  const data = await createReminder(supabase, access, teamMemberId, body as z.infer<typeof createReminderSchema>);

  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/reminders', entityType: 'reminder', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createReminderSchema, permission: 'reminders.manage_own' });
