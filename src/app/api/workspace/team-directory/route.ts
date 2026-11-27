import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess, resolveProjectAccessLevels } from '@/lib/api/access';
import { plainDbError } from '@/lib/api/plain-error';

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
  const { data: everyone, error } = await service.from('team_members').select('*').order('name');
  if (error) return plainDbError(error);

  // A guest (a client, a contractor) sees only the people they work with: members
  // of the projects they are on, plus themselves, with no email or timezone.
  const isGuest = access.role === 'guest';
  let data = everyone;
  if (isGuest) {
    const { data: mine } = await service.from('project_members').select('project_id').eq('member_id', memberId);
    const projectIds = (mine || []).map((row) => row.project_id as string);
    const { data: shared } = projectIds.length
      ? await service.from('project_members').select('member_id').in('project_id', projectIds)
      : { data: [] as { member_id: string }[] };
    const visible = new Set([memberId, ...(shared || []).map((row) => row.member_id as string)]);
    data = (everyone || []).filter((member) => visible.has(member.id));
  }
  // A reach level only, never the permission list behind it.
  const projectAccess = await resolveProjectAccessLevels(service, data || []);
  const directory = (data || []).map((member) => {
    const entry = management || member.id === memberId ? member : {
      id: member.id,
      name: member.name,
      ...(isGuest ? {} : { email: member.email, timezone: member.timezone }),
      avatar: member.avatar,
      role: member.role,
      status: member.status,
    };
    return { ...entry, project_access: projectAccess.get(member.id) ?? 'none' };
  });
  return NextResponse.json({ data: directory });
}
