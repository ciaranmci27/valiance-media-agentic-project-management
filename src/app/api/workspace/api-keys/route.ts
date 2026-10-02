import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { generateApiKey, hashApiKey } from '@/lib/api/crypto';
import { API_ENDPOINT_PERMISSION_SET, type PermissionKey } from '@/lib/access-control';
import { createApiKeySchema } from '@/lib/schemas/api-keys';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';

export const dynamic = 'force-dynamic';

/**
 * Creates an API key for the signed-in member. The key is generated and hashed
 * here, each scope must be an API permission the member holds on the api
 * channel, and the full key is returned once, never stored.
 */
export async function POST(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;

  const parsed = createApiKeySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid API key' }, { status: 422 });
  }
  const { name } = parsed.data;
  const scopes = [...new Set(parsed.data.scopes)];
  const refused = scopes.filter((scope) =>
    !API_ENDPOINT_PERMISSION_SET.has(scope as PermissionKey)
      || !accessAllows(access, scope as PermissionKey, 'api'));
  if (refused.length > 0) {
    return NextResponse.json({ error: `Scopes not available to you: ${refused.join(', ')}` }, { status: 422 });
  }

  const secret = generateApiKey();
  const { data, error } = await service
    .from('api_keys')
    .insert({
      name,
      key_prefix: secret.slice(0, 15),
      key_hash: await hashApiKey(secret),
      created_by: memberId,
      team_member_id: memberId,
      permissions: 'scoped',
      scopes,
    })
    .select(API_KEY_COLUMNS)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });

  return NextResponse.json(
    { data: { key: data, secret } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
