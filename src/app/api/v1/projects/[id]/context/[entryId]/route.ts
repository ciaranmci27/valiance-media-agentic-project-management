import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateProjectContextSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { legacyContextRow, PROJECT_CONTEXT_COLUMNS } from '@/lib/api/project-context';

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id: projectId, entryId } = params as any;
  const updates = body as any;

  const { data: before } = await supabase
    .from('project_context')
    .select(PROJECT_CONTEXT_COLUMNS)
    .eq('id', entryId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (!before) throw notFound('Context entry');

  const { data: updated, error } = await supabase
    .from('project_context')
    .update(updates)
    .eq('id', entryId)
    .eq('project_id', projectId)
    .select(PROJECT_CONTEXT_COLUMNS)
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${projectId}/context/${entryId}`,
    entityType: 'project_context',
    entityId: entryId,
    apiKeyId,
    teamMemberId,
    requestBody: updates,
    beforeSnapshot: before,
    afterSnapshot: updated,
    statusCode: 200,
  });

  return success(legacyContextRow(updated));
}, { schema: updateProjectContextSchema, permission: 'project_context.manage' });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id: projectId, entryId } = params as any;

  const { data: before } = await supabase
    .from('project_context')
    .select(PROJECT_CONTEXT_COLUMNS)
    .eq('id', entryId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (!before) throw notFound('Context entry');

  // Soft delete
  const { data: updated, error } = await supabase
    .from('project_context')
    .update({ is_active: false })
    .eq('id', entryId)
    .eq('project_id', projectId)
    .select(PROJECT_CONTEXT_COLUMNS)
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${projectId}/context/${entryId}`,
    entityType: 'project_context',
    entityId: entryId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: before,
    afterSnapshot: updated,
    statusCode: 200,
  });

  return success(legacyContextRow(updated));
}, { permission: 'project_context.manage' });
