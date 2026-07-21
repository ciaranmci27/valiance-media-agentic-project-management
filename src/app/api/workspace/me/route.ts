import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';

export async function GET() {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;

  const { access, memberId, service } = auth.data;
  const { data: member, error } = await service
    .from('team_members')
    .select('id, auth_user_id, name, email, avatar, role, status, timezone')
    .eq('id', memberId)
    .single();

  if (error || !member) {
    return NextResponse.json({ error: error?.message || 'Team member not found' }, { status: 404 });
  }

  return NextResponse.json({ data: { member, access } });
}
