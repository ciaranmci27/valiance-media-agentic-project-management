import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { addProjectContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { addProjectContact } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  // A contact in Trash leaves the project's contact list with it.
  const { data, count, error } = await supabase
    .from('project_contacts')
    .select('*, contact:contacts!inner(*)', { count: 'exact' })
    .eq('project_id', id)
    .is('contact.deleted_at', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const { data: project } = await supabase.from('projects').select('id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (!project) throw notFound('Project');
  const { contact_id, role, custom_role, is_primary_client } = body as any;
  const { data: contact } = await supabase.from('contacts').select('id').eq('id', contact_id).is('deleted_at', null).maybeSingle();
  if (!contact) throw notFound('Contact');
  const pc = await addProjectContact(supabase, id, contact_id, role, custom_role, is_primary_client);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/projects/${id}/contacts`, entityType: 'project_contact', entityId: pc.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: pc, statusCode: 201 });
  return created(pc);
}, { schema: addProjectContactSchema });
