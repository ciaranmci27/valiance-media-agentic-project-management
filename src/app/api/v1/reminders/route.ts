import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import {
  createReminderSchema,
  REMINDER_SELECT,
  resolveReminderOwner,
  resolveReminderPlace,
  visibleReminderFilter,
} from '@/lib/api/reminders';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;

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
    .or(visibleReminderFilter(access, teamMemberId));
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
  const input = body as z.infer<typeof createReminderSchema>;
  const place = await resolveReminderPlace(supabase, access, input);
  const ownerId = await resolveReminderOwner(supabase, access, teamMemberId, input.owner_id);

  const { data, error } = await supabase
    .from('reminders')
    .insert({
      title: input.title,
      notes: input.notes ?? '',
      remind_on: input.remind_on ?? null,
      remind_at: input.remind_on ? input.remind_at ?? null : null,
      owner_id: ownerId,
      task_id: place.task_id,
      project_id: place.project_id,
      created_by: teamMemberId,
      source: access.role === 'agent' ? 'agent' : 'manual',
    })
    .select(REMINDER_SELECT)
    .single();
  if (error) throw error;

  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/reminders', entityType: 'reminder', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createReminderSchema, permission: 'reminders.manage_own' });
