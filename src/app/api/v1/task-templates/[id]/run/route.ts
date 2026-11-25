import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { currentActorVia } from '@/lib/api/request-context';
import { runTemplate } from '@/lib/api/task-templates';
import { runTaskTemplateSchema, type RunTaskTemplateInput } from '@/lib/task-templates';

/** A full-size playbook (200 tasks) is a few seconds; this is the ceiling, as for the MCP server. */
export const maxDuration = 60;

/**
 * Uses a template: creates every task and subtask in the project at once
 * (each sends task.created as usual), with fill-ins replaced and due dates
 * counted from start_date (default today), then records the run (one
 * template.run webhook). project_id is left out for a template locked to a
 * project; another project is 422 locked_to_project. Answers 201 with
 * { run, tasks, notes }.
 *
 * Permission: tasks.create, on a project the key's member can open.
 */
export const POST = withApi<RunTaskTemplateInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const via = currentActorVia() === 'mcp' ? 'mcp' : 'api';
  const result = await runTemplate(supabase, { memberId: teamMemberId, access, scopes }, params.id, body, via);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/task-templates/${params.id}/run`, entityType: 'task_template', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: result.run, statusCode: 201 });
  return success(result, 201);
}, { schema: runTaskTemplateSchema, optionalBody: true, permission: 'tasks.create' });
