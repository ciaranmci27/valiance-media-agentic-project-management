import { withApi } from '@/lib/api/middleware';
import { created, paginated, success } from '@/lib/api/response';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { listRuns, RUN_PERMISSIONS, runFiltersFrom, startRun } from '@/lib/api/agent-runs';
import { startAgentRunSchema, type StartAgentRunInput } from '@/lib/agent-runs';

/**
 * Runs newest first: stored runs (source run) and the turns that name no run,
 * read as finished runs (source turn). The key's own runs; with agents.manage,
 * every agent's (agent_id narrows it). Filters: agent_id (me or a member id),
 * task_id, project_id, status (running, succeeded, failed, cancelled,
 * timed_out or all), source (run, turn or all).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access, scopes }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const ctx = { db: supabase, access, memberId: teamMemberId, scopes };
  const { rows, total } = await listRuns(ctx, { ...runFiltersFrom(ctx, searchParams), offset, limit });
  return paginated(rows, { page, limit, total });
}, { permission: RUN_PERMISSIONS });

/**
 * Starts a run for the key's own agent (another agent's with agents.manage).
 * The same external_id again answers 200 with that run, updated with what
 * this call sends; a new run answers 201. run.started goes to webhooks.
 */
export const POST = withApi(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { run, created: isNew } = await startRun({ db: supabase, access, memberId: teamMemberId, scopes }, body as StartAgentRunInput);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agents/runs', entityType: 'agent_run', entityId: run.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: run, statusCode: isNew ? 201 : 200 });
  return isNew ? created(run) : success(run);
}, { schema: startAgentRunSchema, optionalBody: true, permission: RUN_PERMISSIONS });
