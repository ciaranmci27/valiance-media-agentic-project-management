import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSessionAccess } from '@/lib/api/access';
import { mayManageKey } from '@/lib/api/key-manage';
import type { AccessContext } from '@/lib/access-control';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import { previewKeyTree, revokeKeyTree } from '@/lib/api/key-revoke';

export const dynamic = 'force-dynamic';

/** The key's member, its creator and holders of api_keys.manage_all: the same people who can see it (lib/api/key-manage.ts). */
async function revocable(service: SupabaseClient, id: string, memberId: string, access: AccessContext): Promise<boolean> {
  const { data: key } = await service
    .from('api_keys')
    .select('id, team_member_id, created_by, revoked_at, permissions')
    .eq('id', id)
    .maybeSingle();
  // A connected app is disconnected from Settings > Account, never revoked as a key.
  return !!key && mayManageKey(key, memberId, access);
}

/**
 * What revoking this key would also take down, without revoking: every live
 * key it made over the API and, through rotation, the keys it replaced
 * (lib/api/key-revoke.ts). Settings names them before the Revoke confirm.
 * Answers { data: { also: [{ id, name, member_name }] } }.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const { id } = await params;
  if (!(await revocable(service, id, memberId, access))) return NextResponse.json({ error: 'API key not found' }, { status: 404 });
  try {
    return NextResponse.json({ data: { also: await previewKeyTree(service, id) } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Could not read what this key made' }, { status: 500 });
  }
}

/**
 * Revokes a key. Allowed for the key's member, its creator and holders of
 * api_keys.manage_all: the same people who can see it. A revoke is final
 * (the api_keys_guard trigger refuses to clear it); revoking again answers
 * with the key as it is. Keys it made over the API are revoked with it, and
 * revoked_ids lists every key revoked (the key itself first), so the screen
 * marks them all.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const { id } = await params;
  if (!(await revocable(service, id, memberId, access))) return NextResponse.json({ error: 'API key not found' }, { status: 404 });

  // Every live key it made over the API goes with it (lib/api/key-revoke.ts),
  // also when the key itself was revoked before its descendants were made.
  let revokedIds: string[];
  try {
    revokedIds = await revokeKeyTree(service, id, { memberId, apiKeyId: null, endpoint: `/api/workspace/api-keys/${id}/revoke`, via: 'app' });
  } catch {
    return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  }

  const { data, error } = await service
    .from('api_keys')
    .select(API_KEY_COLUMNS)
    .eq('id', id)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  return NextResponse.json({ data, revoked_ids: revokedIds });
}
