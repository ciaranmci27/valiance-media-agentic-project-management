import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

// Archive and Trash are different things: an archived project is finished but
// stays readable, a project in Trash is deleted (DELETE /projects/:id).

export const POST = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = params.id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Project');
  const { data, error } = await supabase
    .from('projects')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/archive`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ archived: true, archived_at: data.archived_at });
});

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = params.id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Project');
  const { data, error } = await supabase
    .from('projects')
    .update({ archived_at: null })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}/archive`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ archived: false });
});
