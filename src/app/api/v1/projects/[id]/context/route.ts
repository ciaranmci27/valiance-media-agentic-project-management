import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createProjectContextSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { readProjectContext } from '@/lib/api/project-context';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const projectId = (params as any).id;

  // Verify project exists
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!project) throw notFound('Project');

  // is_active defaults to true; since filters by updated_at.
  const data = await readProjectContext(supabase, projectId, {
    category: searchParams.get('category'),
    isActive: searchParams.get('is_active') !== 'false',
    since: searchParams.get('since'),
  });

  return success(data);
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const projectId = (params as any).id;
  const payload = body as any;

  // Verify project exists
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!project) throw notFound('Project');

  // Upsert logic for existing_work with file_path
  if (payload.category === 'existing_work' && payload.file_path) {
    const { data: existing } = await supabase
      .from('project_context')
      .select('*')
      .eq('project_id', projectId)
      .eq('file_path', payload.file_path)
      .eq('is_active', true)
      .maybeSingle();

    if (existing) {
      const updates: Record<string, any> = { content: payload.content };
      if (payload.source !== undefined) updates.source = payload.source;

      const { data: updated, error } = await supabase
        .from('project_context')
        .update(updates)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;

      logAudit(supabase, {
        method: 'POST',
        endpoint: `/api/v1/projects/${projectId}/context`,
        entityType: 'project_context',
        entityId: updated.id,
        apiKeyId,
        teamMemberId,
        requestBody: payload,
        beforeSnapshot: existing,
        afterSnapshot: updated,
        statusCode: 200,
      });

      return success(updated);
    }
  }

  // Create new entry
  const { data: entry, error } = await supabase
    .from('project_context')
    .insert({
      project_id: projectId,
      category: payload.category,
      content: payload.content,
      source: payload.source || 'human',
      file_path: payload.file_path || null,
    })
    .select()
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${projectId}/context`,
    entityType: 'project_context',
    entityId: entry.id,
    apiKeyId,
    teamMemberId,
    requestBody: payload,
    afterSnapshot: entry,
    statusCode: 201,
  });

  return created(entry);
}, { schema: createProjectContextSchema });
