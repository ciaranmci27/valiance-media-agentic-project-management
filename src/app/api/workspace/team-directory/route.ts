import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';

export async function GET() {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, service, memberId } = auth.data;
  if (!accessAllows(access, 'team.read', 'app') && !accessAllows(access, 'team.manage', 'app')) {
    const { data } = await service
      .from('team_members')
      .select('*')
      .eq('id', memberId)
      .single();
    return NextResponse.json({ data: data ? [data] : [] });
  }

  const management = accessAllows(access, 'team.manage', 'app');
  const { data, error } = await service.from('team_members').select('*').order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const directory = management ? data || [] : (data || []).map((member) => member.id === memberId ? member : ({
    id: member.id,
    name: member.name,
    email: member.email,
    avatar: member.avatar,
    role: member.role,
    status: member.status,
    timezone: member.timezone,
  }));
  return NextResponse.json({ data: directory });
}
