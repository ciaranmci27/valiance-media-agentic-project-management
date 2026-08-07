import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createProjectSchema } from '@/lib/schemas';
import { parsePagination, sanitizeSearch, validateSort } from '@/lib/api/pagination';
import { insertProject } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, apiKeyAllows, sanitizeProjectForAccess } from '@/lib/api/access';
import { forbidden } from '@/lib/api/errors';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const sort = validateSort('projects', searchParams.get('sort'));
  const order = searchParams.get('order') === 'asc';
  const search = searchParams.get('search');
  const status = searchParams.get('status');
  const includeArchived = searchParams.get('include_archived') === 'true';

  let query = supabase.from('projects').select('*, project_members(member_id)', { count: 'exact' });
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
  const { member_ids, contact_id, contact, ...projectData } = body as any;
  if (Array.isArray(member_ids) && !apiKeyAllows(access, scopes, 'project_members.manage')) {
    throw forbidden('Assigning project members requires the project_members.manage API scope');
  }
  if (contact && !apiKeyAllows(access, scopes, 'contacts.manage')) {
    throw forbidden('Creating a project contact requires the contacts.manage API scope');
  }
  if (!apiKeyAllows(access, scopes, 'billing.manage')) {
    for (const field of ['hourly_rate', 'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options', 'client_time_billing']) {
      delete projectData[field];
    }
  }
  if (!apiKeyAllows(access, scopes, 'agents.manage')) {
    for (const field of ['autonomous_enabled', 'auto_merge_enabled', 'integration_branch', 'production_branch', 'suggestions_per_cycle', 'suggestion_queue_cap', 'audit_interval_hours', 'sensitive_paths', 'repo_path']) {
      delete projectData[field];
    }
  }

  // Resolve contact: use existing contact_id, or create a new contact inline
  let resolvedContactId = contact_id || null;
  if (!resolvedContactId && contact) {
    const { data: newContact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        name: contact.name,
        email: contact.email || '',
        phone: contact.phone || '',
        company: contact.company || '',
        color: projectData.color,
        created_by: teamMemberId || null,
      })
      .select()
      .single();

    if (contactError) throw contactError;
    resolvedContactId = newContact.id;
  }

  const project = await insertProject(supabase, projectData, member_ids || [], resolvedContactId);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/projects', entityType: 'project', entityId: project.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: project, statusCode: 201 });
  return created(project);
}, { schema: createProjectSchema });
