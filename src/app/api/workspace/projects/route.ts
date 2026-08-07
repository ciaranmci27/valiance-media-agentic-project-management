import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess, sanitizeProjectForAccess } from '@/lib/api/access';
import { insertProject, patchProject } from '@/lib/supabase/queries';

const BILLING_FIELDS = ['hourly_rate', 'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options', 'client_time_billing'] as const;
const AGENT_FIELDS = ['autonomous_enabled', 'auto_merge_enabled', 'integration_branch', 'production_branch', 'suggestions_per_cycle', 'suggestion_queue_cap', 'audit_interval_hours', 'sensitive_paths', 'repo_path'] as const;
const CORE_FIELDS = ['name', 'description', 'color', 'status', 'start_date', 'due_date', 'hourly_tracking', 'time_tracking_enabled'] as const;
const WRITABLE_FIELDS = new Set<string>([...CORE_FIELDS, ...BILLING_FIELDS, ...AGENT_FIELDS]);

function restrictProjectFields(project: Record<string, unknown>, canBilling: boolean, canAgents: boolean) {
  const restricted = Object.fromEntries(Object.entries(project).filter(([field]) => WRITABLE_FIELDS.has(field)));
  if (!canBilling) BILLING_FIELDS.forEach((field) => delete restricted[field]);
  if (!canAgents) AGENT_FIELDS.forEach((field) => delete restricted[field]);
  return restricted;
}

async function validateMemberIds(service: ReturnType<typeof import('@/lib/api/supabase-service').getServiceClient>, memberIds: string[]) {
  const uniqueIds = [...new Set(memberIds)];
  if (uniqueIds.length === 0) return uniqueIds;
  const { data, error } = await service.from('team_members').select('id').in('id', uniqueIds).eq('status', 'active');
  if (error) throw error;
  if ((data || []).length !== uniqueIds.length) throw new Error('Every assigned team member must be active');
  return uniqueIds;
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, service } = auth.data;
  if (!accessAllows(access, 'projects.read', 'app') && !accessAllows(access, 'projects.read_all', 'app')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let query = service
    .from('projects')
    .select('*, project_members(member_id)')
    .order('created_at', { ascending: false });
  if (!accessAllows(access, 'projects.read_all', 'app')) {
    if (access.project_ids.length === 0) return NextResponse.json({ data: [] });
    query = query.in('id', access.project_ids);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const projects = (data || []).map((project) => {
    const normalized = {
      ...project,
      member_ids: (project.project_members || []).map((row: { member_id: string }) => row.member_id),
    };
    delete normalized.project_members;
    return sanitizeProjectForAccess(normalized, access);
  });
  return NextResponse.json({ data: projects });
}

export async function POST(request: Request) {
  const auth = await requireSessionAccess({ permission: 'projects.manage' });
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.name !== 'string' || !body.name.trim()) return errorResponse('Project name is required');

  const canAssign = accessAllows(access, 'project_members.manage', 'app');
  const requestedMembers = Array.isArray(body.member_ids) ? body.member_ids.filter((id): id is string => typeof id === 'string') : [];
  let memberIds: string[];
  try {
    memberIds = await validateMemberIds(service, canAssign ? requestedMembers : [memberId]);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid team member assignment', 422);
  }
  const projectData = restrictProjectFields(body, accessAllows(access, 'billing.manage', 'app'), accessAllows(access, 'agents.manage', 'app'));
  delete projectData.member_ids;
  projectData.created_by = memberId;

  try {
    const project = await insertProject(service, projectData as never, memberIds);
    const patchedFields = Object.fromEntries([...BILLING_FIELDS, ...AGENT_FIELDS, 'time_tracking_enabled']
      .filter((field) => field in projectData)
      .map((field) => [field, projectData[field]]));
    const result = Object.keys(patchedFields).length > 0
      ? await patchProject(service, project.id, patchedFields, undefined)
      : project;
    return NextResponse.json({ data: sanitizeProjectForAccess({ ...result, member_ids: memberIds }, access) }, { status: 201 });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to create project', 500);
  }
}

export async function PATCH(request: Request) {
  const auth = await requireSessionAccess({ permission: 'projects.manage' });
  if (auth.error) return auth.error;
  const { access, service } = auth.data;
  const body = await request.json().catch(() => null) as (Record<string, unknown> & { id?: string }) | null;
  if (!body?.id) return errorResponse('Project id is required');
  if (!accessAllows(access, 'projects.read_all', 'app') && !access.project_ids.includes(body.id)) return errorResponse('Project access denied', 403);

  const updates = restrictProjectFields(body, accessAllows(access, 'billing.manage', 'app'), accessAllows(access, 'agents.manage', 'app'));
  let memberIds: string[] | undefined;
  if ('member_ids' in body) {
    if (!accessAllows(access, 'project_members.manage', 'app')) return errorResponse('Assigning project members is forbidden', 403);
    const requestedMembers = Array.isArray(body.member_ids) ? body.member_ids.filter((id): id is string => typeof id === 'string') : [];
    try {
      memberIds = await validateMemberIds(service, requestedMembers);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Invalid team member assignment', 422);
    }
  }
  try {
    const project = await patchProject(service, body.id, updates, memberIds);
    return NextResponse.json({ data: sanitizeProjectForAccess(project as unknown as Record<string, unknown>, access) });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to update project', 500);
  }
}

export async function DELETE(request: Request) {
  const auth = await requireSessionAccess({ permission: 'projects.manage' });
  if (auth.error) return auth.error;
  const { access, service } = auth.data;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return errorResponse('Project id is required');
  if (!accessAllows(access, 'projects.read_all', 'app') && !access.project_ids.includes(id)) return errorResponse('Project access denied', 403);
  const { error } = await service.from('projects').delete().eq('id', id);
  if (error) return errorResponse(error.message, 500);
  return new NextResponse(null, { status: 204 });
}
