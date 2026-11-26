import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { reflowTemplateRun } from '@/lib/api/template-reflow';
import { reflowTemplateRunSchema, type ReflowTemplateRunInput } from '@/lib/task-templates';

/**
 * Changes a live run's key dates (a run that made an initiative). Due dates
 * recompute from key date plus offset only; a task moves only while it is not
 * done, not in Trash and still due on its planned date (include_task_ids
 * moves a hand-changed one anyway); the initiative's target date follows the
 * main key date the same way. dry_run true answers the same plan, writing
 * nothing. Answers { moved, kept, ignored, unchanged, initiative, warnings,
 * key_dates }. A run whose dates changed since it was read is 409 run_changed.
 *
 * Permission: tasks.create, on the run's project; only tasks the key may edit move.
 */
export const POST = withApi<ReflowTemplateRunInput, { runId: string }>(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const result = await reflowTemplateRun(supabase, { memberId: teamMemberId, access, scopes }, params.runId, body);
  if (!result.dry_run) {
    logAudit(supabase, { method: 'POST', endpoint: `/api/v1/task-templates/runs/${params.runId}/reflow`, entityType: 'task_template_run', entityId: params.runId, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: { key_dates: result.key_dates, moved: result.moved.length }, statusCode: 200 });
  }
  return success(result);
}, { schema: reflowTemplateRunSchema, permission: 'tasks.create' });
