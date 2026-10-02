import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';

export const dynamic = 'force-dynamic';

/**
 * Revokes a key. Allowed for the key's member, its creator and holders of
 * api_keys.manage_all: the same people who can see it. A revoke is final
 * (the api_keys_guard trigger refuses to clear it); revoking again answers
 * with the key as it is.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const { id } = await params;

  const { data: key } = await service
    .from('api_keys')
    .select('id, team_member_id, created_by, revoked_at')
    .eq('id', id)
    .maybeSingle();
  const allowed = key && (
    key.team_member_id === memberId
      || key.created_by === memberId
      || accessAllows(access, 'api_keys.manage_all', 'app')
  );
  if (!allowed) return NextResponse.json({ error: 'API key not found' }, { status: 404 });

  if (!key.revoked_at) {
    const { error } = await service
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .is('revoked_at', null);
    if (error) return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  }

  const { data, error } = await service
    .from('api_keys')
    .select(API_KEY_COLUMNS)
    .eq('id', id)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  return NextResponse.json({ data });
}
