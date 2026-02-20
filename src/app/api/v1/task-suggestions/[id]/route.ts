import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateSuggestionSchema } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { notFound } from '@/lib/api/errors';
import { patchTaskSuggestion } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi<unknown, { id: string }>(async ({ supabase, params }) => {
  requireAgentsEnabled();

  const { data, error } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (error || !data) throw notFound('Suggestion');
  return success(data);
});

export const PATCH = withApi<any, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled();

  const { data: before } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!before) throw notFound('Suggestion');

  const updated = await patchTaskSuggestion(supabase, params.id, body);

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/task-suggestions/${params.id}`,
    entityType: 'suggestion',
    entityId: params.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: updated,
    statusCode: 200,
  });

  return success(updated);
}, { schema: updateSuggestionSchema });
