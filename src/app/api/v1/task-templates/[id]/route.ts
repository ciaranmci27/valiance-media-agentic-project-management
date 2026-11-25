import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { getTemplate, trashTemplate, updateTemplate } from '@/lib/api/task-templates';
import { updateTaskTemplateSchema, type UpdateTaskTemplateInput } from '@/lib/task-templates';

/** One template with its tasks. Permission: tasks.create or templates.manage. */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes }) =>
  success(await getTemplate(supabase, { memberId: teamMemberId, access, scopes }, params.id)), { permission: ['tasks.create', 'templates.manage'] });

/**
 * Changes a template. Send only what changes; fields and items are replaced
 * whole. Its version goes up when what it makes changes. Permission:
 * templates.manage.
 */
export const PATCH = withApi<UpdateTaskTemplateInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { before, template } = await updateTemplate(supabase, { memberId: teamMemberId, access, scopes }, params.id, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/task-templates/${params.id}`, entityType: 'task_template', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: template, statusCode: 200 });
  return success(template);
}, { schema: updateTaskTemplateSchema, permission: 'templates.manage' });

/**
 * Moves a template to Trash: it leaves the library; the tasks it already
 * made and its runs stay. Permission: templates.manage.
 */
export const DELETE = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes, apiKeyId }) => {
  const template = await trashTemplate(supabase, { memberId: teamMemberId, access, scopes }, params.id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/task-templates/${params.id}`, entityType: 'task_template', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: template, statusCode: 200 });
  return success({ id: params.id, deleted: true });
}, { permission: 'templates.manage' });
