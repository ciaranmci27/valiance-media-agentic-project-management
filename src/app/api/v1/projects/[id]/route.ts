import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateProjectSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { patchProject } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*, project_members(member_id)')
    .eq('id', (params as any).id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');

  const project = {
    ...data,
    member_ids: (data.project_members || []).map((pm: any) => pm.member_id),
    project_members: undefined,
  };

  return success(project);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).maybeSingle();
  const { member_ids, ...updates } = body as any;
  const project = await patchProject(supabase, id, updates, member_ids);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/projects/${id}`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: project, statusCode: 200 });
  return success(project);
}, { schema: updateProjectSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const id = (params as any).id;
  const { data: before } = await supabase.from('projects').select('*').eq('id', id).maybeSingle();
  // Soft delete: set archived_at
  const { data, error } = await supabase
    .from('projects')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/projects/${id}`, entityType: 'project', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ archived: true, archived_at: data.archived_at });
});
