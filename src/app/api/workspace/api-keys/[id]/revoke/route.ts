import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import { revokeKeyTree } from '@/lib/api/key-revoke';

export const dynamic = 'force-dynamic';

/**
 * Revokes a key. Allowed for the key's member, its creator and holders of
 * api_keys.manage_all: the same people who can see it. A revoke is final
 * (the api_keys_guard trigger refuses to clear it); revoking again answers
 * with the key as it is. Keys it made over the API are revoked with it.
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
    .select('id, team_member_id, created_by, revoked_at, permissions')
    .eq('id', id)
    .maybeSingle();
  // A connected app is disconnected from Settings > Account, never revoked as a key.
  const allowed = key && key.permissions !== 'connection' && (
    key.team_member_id === memberId
      || key.created_by === memberId
      || accessAllows(access, 'api_keys.manage_all', 'app')
  );
  if (!allowed) return NextResponse.json({ error: 'API key not found' }, { status: 404 });

  // Every live key it made over the API goes with it (lib/api/key-revoke.ts),
  // also when the key itself was revoked before its descendants were made.
  try {
    await revokeKeyTree(service, id, { memberId, apiKeyId: null, endpoint: `/api/workspace/api-keys/${id}/revoke`, via: 'app' });
  } catch {
    return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  }

  const { data, error } = await service
    .from('api_keys')
    .select(API_KEY_COLUMNS)
    .eq('id', id)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  return NextResponse.json({ data });
}
