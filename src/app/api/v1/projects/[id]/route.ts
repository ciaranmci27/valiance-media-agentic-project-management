import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateProjectSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { patchProject } from '@/lib/supabase/queries';

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

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { member_ids, ...updates } = body as any;
  const project = await patchProject(supabase, (params as any).id, updates, member_ids);
  return success(project);
}, { schema: updateProjectSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  // Soft delete: set archived_at
  const { data, error } = await supabase
    .from('projects')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', (params as any).id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Project');
  return success({ archived: true, archived_at: data.archived_at });
});
