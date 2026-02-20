import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { addProjectContactSchema } from '@/lib/schemas';
import { addProjectContact } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;

  const { data, error } = await supabase
    .from('project_contacts')
    .select('*, contact:contacts(*)')
    .eq('project_id', id)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const { contact_id, role, custom_role, is_primary_client } = body as any;
  const pc = await addProjectContact(supabase, id, contact_id, role, custom_role, is_primary_client);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/contacts`, entityType: 'project_contact', entityId: pc.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: pc, statusCode: 201 });
  return created(pc);
}, { schema: addProjectContactSchema });
