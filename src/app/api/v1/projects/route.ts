import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createProjectSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { createProjectFromApi } from '@/lib/api/project-create';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, sanitizeProjectForAccess } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = validateSort('projects', searchParams.get('sort'));
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const includeArchived = searchParams.get('include_archived') === 'true';

  // Archived projects are finished but readable; projects in Trash are deleted
  // and never listed, whatever include_archived says.
  let query = supabase.from('projects').select('*, project_members(member_id)', { count: 'exact' }).is('deleted_at', null);
  if (!accessAllows(access, 'projects.read_all', 'api')) {
    if (access.project_ids.length === 0) return paginated([], { page, limit, total: 0 });
    query = query.in('id', access.project_ids);
  }

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

  const projects = (data || []).map((p: any) => sanitizeProjectForAccess({
    ...p,
    member_ids: (p.project_members || []).map((pm: any) => pm.member_id),
    project_members: undefined,
  }, access, 'api'));

  return paginated(projects, { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access, scopes }) => {
  // The one create path (lib/api/project-create.ts), also behind project setup.
  const project = await createProjectFromApi(supabase, { access, scopes, teamMemberId }, body as Record<string, unknown>);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/projects', entityType: 'project', entityId: project.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: project, statusCode: 201 });
  return created(project);
}, { schema: createProjectSchema });
