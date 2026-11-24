import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { finishRun, RUN_PERMISSIONS } from '@/lib/api/agent-runs';
import { finishAgentRunSchema, type FinishAgentRunInput } from '@/lib/agent-runs';

/**
 * Finishes a run: status succeeded (default), failed, cancelled or timed_out,
 * with any final details (summary, tokens, cost, trace link). Finishing again
 * with the same status answers with the run; another status is 409
 * run_finished. run.finished goes to webhooks.
 */
export const POST = withApi(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { id } = params as { id: string };
  const run = await finishRun({ db: supabase, access, memberId: teamMemberId, scopes }, id, body as FinishAgentRunInput);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/agents/runs/${id}/finish`, entityType: 'agent_run', entityId: id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: run, statusCode: 200 });
  return success(run);
}, { schema: finishAgentRunSchema, optionalBody: true, permission: RUN_PERMISSIONS });
