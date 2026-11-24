import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { accessAllowsProject, apiKeyAllows } from '@/lib/api/access';
import { AGENT_LABELS_MAX, agentLabelSchema } from '@/lib/agent-events';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const labelList = z.array(agentLabelSchema).max(AGENT_LABELS_MAX * 4);

const editAgentActivityLabelsSchema = z.object({
  add: labelList.optional(),
  remove: labelList.optional(),
}).strict().refine((body) => (body.add?.length ?? 0) + (body.remove?.length ?? 0) > 0, 'Send add or remove with at least one label');

type EditLabels = z.infer<typeof editAgentActivityLabelsSchema>;

/** Postgres or PostgREST for a function the database does not have yet. */
const missingFunction = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || /edit_agent_activity_labels/.test(error.message ?? ''));

/**
 * Adds or removes labels on one agent event after the fact: an event's own
 * agent, or a key with agents.manage (key and member). Another agent's event
 * is 404, as for runs. Removing runs after adding, so a label in both ends
 * up removed. An event holds at most 20 labels (422 too_many_labels).
 * Answers with the event.
 */
export const POST = withApi(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  requireAgentsEnabled(access);
  const { id } = params as { id: string };
  if (!UUID.test(id)) throw notFound('Agent event');

  const { data: before, error: readError } = await supabase.from('agent_activities').select('*').eq('id', id).maybeSingle();
  if (readError) throw readError;
  const manages = apiKeyAllows(access, scopes, 'agents.manage');
  const own = !!before && before.agent_id === teamMemberId && apiKeyAllows(access, scopes, 'agent_activity.write');
  if (!before || (!manages && !own) || (before.project_id && !accessAllowsProject(access, before.project_id, 'api'))) {
    throw notFound('Agent event');
  }

  const { add, remove } = body as EditLabels;
  const { data: labels, error } = await supabase.rpc('edit_agent_activity_labels', {
    p_activity_id: id,
    p_add: [...new Set(add ?? [])],
    p_remove: [...new Set(remove ?? [])],
  });
  if (error) {
    if (missingFunction(error)) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'labels are recorded once the database update 20261124001200_agent_event_pipeline.sql is applied', { reason: 'migration_pending' });
    }
    if (error.code === '23514') {
      throw new ApiError(422, 'VALIDATION_ERROR', `An event holds at most ${AGENT_LABELS_MAX} labels`, { reason: 'too_many_labels', labels: before.labels ?? [] });
    }
    throw error;
  }
  if (labels === null) throw notFound('Agent event');

  const { data: after, error: afterError } = await supabase.from('agent_activities').select('*').eq('id', id).single();
  if (afterError) throw afterError;
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/agent-activities/${id}/labels`,
    entityType: 'agent_activities',
    entityId: id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: after,
    statusCode: 200,
  });
  return success(after);
}, { schema: editAgentActivityLabelsSchema, permission: ['agent_activity.write', 'agents.manage'] });
