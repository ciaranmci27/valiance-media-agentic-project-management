import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createProjectSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { insertProject } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = validateSort('projects', searchParams.get('sort'));
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const includeArchived = searchParams.get('include_archived') === 'true';

  let query = supabase.from('projects').select('*, project_members(member_id)', { count: 'exact' });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }
  if (status) query = query.eq('status', status);
  const autonomousEnabled = searchParams.get('autonomous_enabled');
  if (autonomousEnabled === 'true' || autonomousEnabled === 'false') {
    query = query.eq('autonomous_enabled', autonomousEnabled === 'true');
  }
  if (search) {
    const s = sanitizeSearch(search);
    query = query.or(`name.ilike.%${s}%,description.ilike.%${s}%`);
  }

  const { data, count, error } = await query
    .order(sort, { ascending: order })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  const projects = (data || []).map((p: any) => ({
    ...p,
    member_ids: (p.project_members || []).map((pm: any) => pm.member_id),
    project_members: undefined,
  }));

  return paginated(projects, { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const { member_ids, ...projectData } = body as any;
  const project = await insertProject(supabase, projectData, member_ids || []);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/projects', entityType: 'project', entityId: project.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: project, statusCode: 201 });
  return created(project);
}, { schema: createProjectSchema });
