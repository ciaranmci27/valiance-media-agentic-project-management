import { NextResponse } from 'next/server';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';

export async function GET(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, service, memberId } = auth.data;
  if (!accessAllows(access, 'credentials.manage', 'app') && !accessAllows(access, 'credentials.reveal_shared', 'app')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const projectId = new URL(request.url).searchParams.get('project_id');

  let query = service
    .from('project_credentials')
    .select('id, project_id, label, category, submitted_by_client, submitted_by_name, created_by, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);

  if (!accessAllows(access, 'credentials.manage', 'app')) {
    const { data: grants } = await service
      .from('project_credential_members')
      .select('credential_id')
      .eq('member_id', memberId);
    const ids = (grants || []).map((row) => row.credential_id);
    if (ids.length === 0) return NextResponse.json({ data: [] });
    query = query.in('id', ids);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  let visible = (data || []).filter((credential) => accessAllowsProject(access, credential.project_id));
  if (accessAllows(access, 'credentials.manage', 'app') && visible.length > 0) {
    const { data: grants } = await service.from('project_credential_members').select('credential_id, member_id').in('credential_id', visible.map((credential) => credential.id));
    visible = visible.map((credential) => ({ ...credential, shared_member_ids: (grants || []).filter((grant) => grant.credential_id === credential.id).map((grant) => grant.member_id) }));
  }
  return NextResponse.json({ data: visible });
}

export async function PUT(request: Request) {
  const auth = await requireSessionAccess({ permission: 'credentials.manage' });
  if (auth.error) return auth.error;
  const body = await request.json() as { credential_id?: string; member_ids?: string[] };
  if (!body.credential_id || !Array.isArray(body.member_ids)) return NextResponse.json({ error: 'Credential and member list are required' }, { status: 422 });
  const { error } = await auth.data.client.rpc('set_credential_members', { p_credential_id: body.credential_id, p_member_ids: body.member_ids });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
