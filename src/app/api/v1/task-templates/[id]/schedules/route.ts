import { withApi } from '@/lib/api/middleware';
import { paginated, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { createTemplateSchedule, listSchedules } from '@/lib/api/schedules';
import { templateScheduleSchema, type TemplateScheduleInput } from '@/lib/schedules';

/** A template's schedules, soonest next first, on projects the key's member can open. Permission: tasks.create or templates.manage. */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listSchedules(supabase, { memberId: teamMemberId, access, scopes }, { kind: 'template', template_id: params.id, offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.create', 'templates.manage'] });

/**
 * Runs the template on a schedule: every date of the recurrence, in its
 * time zone, with its own project, role map, fill-in values (date and month
 * filled on each run), key date offsets, create_initiative and
 * skip_if_open. Checked like a run for its first date. Answers 201 with the
 * schedule (next_on, upcoming). Permission: tasks.create on the project.
 */
export const POST = withApi<TemplateScheduleInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const schedule = await createTemplateSchedule(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/task-templates/${params.id}/schedules`, entityType: 'schedule', entityId: schedule.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: schedule, statusCode: 201 });
  return success(schedule, 201);
}, { schema: templateScheduleSchema, permission: 'tasks.create' });
