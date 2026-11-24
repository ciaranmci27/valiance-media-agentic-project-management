import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess, sanitizeProjectForAccess } from '@/lib/api/access';
import { patchProject } from '@/lib/supabase/queries';
import { createProjectFromSession, ProjectCreateError, restrictProjectFields, validateMemberIds } from '@/lib/api/project-create';
import { moveToTrash, TRASH_ERROR_STATUS, TrashError } from '@/lib/supabase/trash';

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
    .is('deleted_at', null)
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
  if (!body) return errorResponse('Project name is required');
  // The one create path (lib/api/project-create.ts), also behind project setup.
  try {
    return NextResponse.json({ data: await createProjectFromSession(service, access, memberId, body) }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectCreateError) return errorResponse(error.message, error.status);
    return errorResponse(error instanceof Error ? error.message : 'Failed to create project', 500);
  }
}

export async function PATCH(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, service } = auth.data;
  const body = await request.json().catch(() => null) as (Record<string, unknown> & { id?: string }) | null;
  if (!body?.id) return errorResponse('Project id is required');
  // projects.manage edits the project. project_members.manage on its own is
  // enough for a membership-only change, and for nothing else.
  const membersOnly = Object.keys(body).every((key) => key === 'id' || key === 'member_ids');
  const canManageProject = accessAllows(access, 'projects.manage', 'app');
  if (!canManageProject && !(membersOnly && accessAllows(access, 'project_members.manage', 'app'))) {
    return errorResponse('Forbidden', 403);
  }
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
  const { access, client } = auth.data;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return errorResponse('Project id is required');
  if (!accessAllows(access, 'projects.read_all', 'app') && !access.project_ids.includes(id)) return errorResponse('Project access denied', 403);
  // Moves the project to Trash as the signed-in member: the database checks
  // their delete permission, stamps them and writes the audit row. Everything
  // the project owns stays as it was, out of reach until it is restored.
  try {
    await moveToTrash(client, 'projects', id);
  } catch (error) {
    if (error instanceof TrashError) {
      return errorResponse(error.message, TRASH_ERROR_STATUS[error.reason]);
    }
    return errorResponse(error instanceof Error ? error.message : 'Failed to delete project', 500);
  }
  return new NextResponse(null, { status: 204 });
}
