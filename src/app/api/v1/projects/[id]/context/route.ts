import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { createProjectContextSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const projectId = (params as any).id;

  // Verify project exists
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) throw notFound('Project');

  let query = supabase
    .from('project_context')
    .select('*')
    .eq('project_id', projectId);

  // Filter by category
  const category = searchParams.get('category');
  if (category) {
    query = query.eq('category', category);
  }

  // Filter by is_active (default: true)
  const isActiveParam = searchParams.get('is_active');
  const isActive = isActiveParam === 'false' ? false : true;
  query = query.eq('is_active', isActive);

  // Filter by updated since
  const since = searchParams.get('since');
  if (since) {
    query = query.gte('updated_at', since);
  }

  query = query.order('category').order('created_at').limit(500);

  const { data, error } = await query;
  if (error) throw error;

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
