import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';

const MEMBER_COLUMNS = 'id, auth_user_id, name, email, avatar, role, status, timezone, theme_preference, scene_preferences';

export async function GET() {
  // The member's own row comes back with the access lookup, in the same read.
  const auth = await requireSessionAccess({ memberColumns: MEMBER_COLUMNS });
  if (auth.error) return auth.error;

  const { access, memberId, memberRow, service } = auth.data;
  let member = memberRow;
  // Before the authorization migration the lookup takes its legacy path and
  // returns no row; read it on its own as before.
  if (!member) {
    const { data, error } = await service
      .from('team_members')
      .select(MEMBER_COLUMNS)
      .eq('id', memberId)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Team member not found' }, { status: 404 });
    }
    member = data as unknown as Record<string, unknown>;
  }

  return NextResponse.json({ data: { member: pick(member, MEMBER_COLUMNS), access } });
}

/** Exactly the columns /me has always returned, nothing the lookup added. */
function pick(row: Record<string, unknown>, columns: string) {
  return Object.fromEntries(columns.split(',').map((c) => c.trim()).map((c) => [c, row[c]]));
}
