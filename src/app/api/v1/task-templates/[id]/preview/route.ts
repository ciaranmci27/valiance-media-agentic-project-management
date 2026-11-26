import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { previewTemplateRun } from '@/lib/api/task-templates';
import { runTaskTemplateSchema, type RunTaskTemplateInput } from '@/lib/task-templates';

/**
 * A dry run: takes what POST /api/v1/task-templates/:id/run takes and
 * answers what that run would make, writing nothing: { ok, errors, tasks
 * (dated, assigned, keyed, with subtasks), dependencies, initiative, roles,
 * key_dates, values, notes }. ok false lists every reason the run would be
 * refused, each with its path and a fix. An agent's own rules (paused on the
 * project, new tasks needing approval) are checked only by the run.
 *
 * Permission: tasks.create, on a project the key's member can open.
 */
export const POST = withApi<RunTaskTemplateInput, { id: string }>(async ({ supabase, params, body, teamMemberId, access, scopes }) =>
  success(await previewTemplateRun(supabase, { memberId: teamMemberId, access, scopes }, params.id, body)),
{ schema: runTaskTemplateSchema, optionalBody: true, permission: 'tasks.create' });
