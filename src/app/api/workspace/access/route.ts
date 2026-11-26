import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { PERMISSIONS, TEAM_ROLES, type AccessChannel, type AccessContext, type PermissionEffect } from '@/lib/access-control';

/**
 * Roles & permissions (Team): an Owner, or anyone an Owner gave Manage
 * access (access.manage; no role holds it by default). A holder who is not
 * an Owner never changes their own access (their own overrides or their own
 * role's defaults) and never gives or takes away Manage access itself: only
 * an Owner does, so the power cannot spread or grow on its own.
 */
const managesAccess = (access: AccessContext) => access.role === 'owner' || accessAllows(access, 'access.manage', 'app');

export async function GET() {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!managesAccess(auth.data.access)) return NextResponse.json({ error: 'Manage access required' }, { status: 403 });
  const { service } = auth.data;
  const [roles, members] = await Promise.all([
    service.from('role_permissions').select('*').order('role').order('permission_key'),
    service.from('team_member_permissions').select('*').order('member_id').order('permission_key'),
  ]);
  if (roles.error || members.error) {
    return NextResponse.json({ error: roles.error?.message || members.error?.message }, { status: 500 });
  }
  return NextResponse.json({ data: { role_permissions: roles.data || [], member_permissions: members.data || [] } });
}

export async function PUT(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!managesAccess(auth.data.access)) return NextResponse.json({ error: 'Manage access required' }, { status: 403 });
  const { memberId, service, access } = auth.data;
  const owner = access.role === 'owner';
  const body = await request.json() as {
    target: 'role' | 'member';
    role?: string;
    member_id?: string;
    permission_key?: string;
    access_channel?: AccessChannel;
    enabled?: boolean;
    effect?: PermissionEffect | null;
  };
  if (!body.permission_key || !PERMISSIONS.includes(body.permission_key as never)) {
    return NextResponse.json({ error: 'Invalid permission' }, { status: 422 });
  }
  if (!['app', 'api'].includes(body.access_channel || '')) {
    return NextResponse.json({ error: 'Invalid access channel' }, { status: 422 });
  }
  if (!['role', 'member'].includes(body.target)) {
    return NextResponse.json({ error: 'Invalid permission target' }, { status: 422 });
  }
  if (!owner && body.permission_key === 'access.manage') {
    return NextResponse.json({ error: 'Only an Owner gives or takes away Manage access' }, { status: 403 });
  }

  if (body.target === 'role') {
    if (!body.role || body.role === 'owner' || !TEAM_ROLES.includes(body.role as never)) {
      return NextResponse.json({ error: 'Invalid editable role' }, { status: 422 });
    }
    if (!owner && body.role === access.role) {
      return NextResponse.json({ error: 'You cannot change the defaults of your own role. Ask an Owner.' }, { status: 403 });
    }
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Enabled must be true or false' }, { status: 422 });
    }
    const match = {
      role: body.role,
      permission_key: body.permission_key,
      access_channel: body.access_channel!,
    };
    const result = body.enabled
      ? await service.from('role_permissions').upsert(match).select().single()
      : await service.from('role_permissions').delete().match(match);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  } else {
    if (!body.member_id) return NextResponse.json({ error: 'Member is required' }, { status: 422 });
    if (!owner && body.member_id === memberId) {
      return NextResponse.json({ error: 'You cannot change your own access. Ask an Owner.' }, { status: 403 });
    }
    if (body.effect !== null && body.effect !== 'allow' && body.effect !== 'deny') {
      return NextResponse.json({ error: 'Invalid permission effect' }, { status: 422 });
    }
    const { data: targetMember } = await service
      .from('team_members')
      .select('id, role')
      .eq('id', body.member_id)
      .maybeSingle();
    if (!targetMember) return NextResponse.json({ error: 'Team member not found' }, { status: 404 });
    if (targetMember.role === 'owner') {
      return NextResponse.json({ error: 'Owners always have full access and cannot have overrides' }, { status: 409 });
    }
    const match = {
      member_id: body.member_id,
      permission_key: body.permission_key,
      access_channel: body.access_channel!,
    };
    const result = body.effect
      ? await service.from('team_member_permissions').upsert({ ...match, effect: body.effect, created_by: memberId }).select().single()
      : await service.from('team_member_permissions').delete().match(match);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
