import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { getRun, RUN_PERMISSIONS, updateRun } from '@/lib/api/agent-runs';
import { updateAgentRunSchema, type UpdateAgentRunInput } from '@/lib/agent-runs';

/** One run: a stored run with its plan, notes and attached turns, or a turn read as a finished run. 404 when hidden or missing. */
export const GET = withApi(async ({ supabase, params, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  return success(await getRun({ db: supabase, access, memberId: teamMemberId, scopes }, id));
}, { permission: RUN_PERMISSIONS });

/**
 * Changes a run: plan (replaces it), note (adds a progress note), tokens and
 * cost so far (totals, not increments), title, summary, model, task,
 * external_url, metadata; a finished status finishes it. Only the run's
 * agent, or a key with agents.manage. 409 run_finished to change a finished
 * run's status.
 */
export const PATCH = withApi(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { id } = params as { id: string };
  const run = await updateRun({ db: supabase, access, memberId: teamMemberId, scopes }, id, body as UpdateAgentRunInput);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/agents/runs/${id}`, entityType: 'agent_run', entityId: id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: run, statusCode: 200 });
  return success(run);
}, { schema: updateAgentRunSchema, permission: RUN_PERMISSIONS });
