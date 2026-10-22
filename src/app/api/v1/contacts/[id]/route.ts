import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { trashForApi } from '@/lib/api/trash';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', (params as any).id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Contact');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('contacts').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  const { data, error } = await supabase
    .from('contacts')
    .update(body)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Contact');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/contacts/${id}`, entityType: 'contact', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateContactSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('contacts').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!before) throw notFound('Contact');

  await trashForApi(supabase, 'contacts', id, teamMemberId, 'Contact');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/contacts/${id}`, entityType: 'contact', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, statusCode: 200 });
  return success({ deleted: true });
});
