import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

// Archive and Trash are different things: an archived lead is closed but
// stays readable, a lead in Trash is deleted (DELETE /leads/:id).

export const POST = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = params.id;
  const { data: before } = await supabase.from('leads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Lead');
  const { data, error } = await supabase
    .from('leads')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead');
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/archive`, entityType: 'lead', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ archived: true, archived_at: data.archived_at });
});

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = params.id;
  const { data: before } = await supabase.from('leads').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Lead');
  const { data, error } = await supabase
    .from('leads')
    .update({ archived_at: null })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/leads/${id}/archive`, entityType: 'lead', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ archived: false });
});
