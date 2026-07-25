import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { TEAM_ROLES } from '@/lib/access-control';

const PROFILE_FIELDS = ['name', 'avatar', 'timezone', 'notification_prefs', 'email_notifications_enabled', 'email_notification_prefs', 'theme_preference'] as const;
const MANAGEMENT_FIELDS = [...PROFILE_FIELDS, 'status'] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { id } = await params;
  const { access, memberId, service } = auth.data;
  const body = await request.json() as Record<string, unknown>;
  const isOwner = access.role === 'owner';
  const isSelf = id === memberId;
  const canManage = accessAllows(access, 'team.manage', 'app');
  if (!isSelf && !canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: target } = await service
    .from('team_members')
    .select('id, role')
    .eq('id', id)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: 'Team member not found' }, { status: 404 });
  if (target.role === 'owner' && !isSelf && !isOwner) {
    return NextResponse.json({ error: 'The Owner account cannot be modified by another member' }, { status: 403 });
  }

  const allowed = isOwner ? [...MANAGEMENT_FIELDS, 'role'] : isSelf ? PROFILE_FIELDS : MANAGEMENT_FIELDS;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }
  if ('role' in updates) {
    if (!TEAM_ROLES.includes(updates.role as never)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 422 });
    }
    if (!isOwner || (isSelf && target.role === 'owner')) {
      return NextResponse.json({ error: 'Only an Owner can assign roles, and an Owner cannot change their own role' }, { status: 403 });
    }
  }
  if ('status' in updates && !['active', 'suspended'].includes(String(updates.status))) {
    return NextResponse.json({ error: 'Invalid member status' }, { status: 422 });
  }
  if ('theme_preference' in updates && updates.theme_preference !== null && !['light', 'dark'].includes(String(updates.theme_preference))) {
    return NextResponse.json({ error: 'Invalid theme preference' }, { status: 422 });
  }
  if ('email_notifications_enabled' in updates && typeof updates.email_notifications_enabled !== 'boolean') {
    return NextResponse.json({ error: 'Invalid email notifications value' }, { status: 422 });
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'No permitted changes' }, { status: 400 });
  if (updates.status === 'suspended') {
    updates.suspended_at = new Date().toISOString();
    updates.suspended_by = memberId;
  } else if (updates.status === 'active') {
    updates.suspended_at = null;
    updates.suspended_by = null;
  }

  const { data, error } = await service
    .from('team_members')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
