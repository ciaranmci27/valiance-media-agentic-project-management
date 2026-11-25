import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { createTemplate, listTemplates, templateFiltersFrom } from '@/lib/api/task-templates';
import { createTaskTemplateSchema, type CreateTaskTemplateInput } from '@/lib/task-templates';

/**
 * The task templates the key's member may read, by name, paged, without
 * their tasks (GET /api/v1/task-templates/:id has them). Filters: search
 * (name), project_id (only those usable there: unlocked ones and the ones
 * locked to it). A template locked to a project the member cannot open is
 * left out. Each with fields, item_count, task_count, version, run_count
 * and last_run_at.
 *
 * Permission: tasks.create or templates.manage.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listTemplates(supabase, { memberId: teamMemberId, access, scopes }, { ...templateFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.create', 'templates.manage'] });

/**
 * Creates a template: name, description, project_id (locks it to that
 * project; null for any), fields (fill-ins its titles and descriptions use,
 * such as {product}) and items (the tasks, each with optional subtasks).
 *
 * Permission: templates.manage.
 */
export const POST = withApi<CreateTaskTemplateInput>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const template = await createTemplate(supabase, { memberId: teamMemberId, access, scopes }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/task-templates', entityType: 'task_template', entityId: template.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: template, statusCode: 201 });
  return created(template);
}, { schema: createTaskTemplateSchema, permission: 'templates.manage' });
