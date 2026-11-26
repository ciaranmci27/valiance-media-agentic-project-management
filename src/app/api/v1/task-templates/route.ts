import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { createTemplate, listTemplates, templateFiltersFrom } from '@/lib/api/task-templates';

/**
 * The task templates the key's member may read, by name, paged, without
 * their tasks (GET /api/v1/task-templates/:id has them). Filters: search
 * (name), project_id (only those usable there: company-wide ones and that
 * project's own, its own first), scope (project or workspace). A project's
 * template is left out when the member cannot open the project. Each with
 * scope, can_edit, key_dates, roles, fields, item_count, task_count,
 * version, run_count and last_run_at.
 *
 * Permission: tasks.create or templates.manage.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { rows, total } = await listTemplates(supabase, { memberId: teamMemberId, access, scopes }, { ...templateFiltersFrom(searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: ['tasks.create', 'templates.manage'] });

/**
 * Creates a template from the documented JSON template (GET
 * /api/v1/task-templates/schema): name, description, project_id (the project
 * it belongs to; null for company-wide), guidance, key_dates, roles, fields
 * and items. Checked whole: a refusal (422) lists every error with its JSON
 * path and a fix, the same as POST /api/v1/task-templates/validate.
 * Idempotency-Key: a retry gets the first answer back.
 *
 * Permission: templates.manage for a company-wide template; projects.manage
 * (whoever manages the project) or templates.manage for a project's.
 */
export const POST = withApi<Record<string, unknown>>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const template = await createTemplate(supabase, { memberId: teamMemberId, access, scopes }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/task-templates', entityType: 'task_template', entityId: template.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: template, statusCode: 201 });
  return created(template);
}, { schema: z.record(z.string(), z.unknown()), permission: ['templates.manage', 'projects.manage'] });
