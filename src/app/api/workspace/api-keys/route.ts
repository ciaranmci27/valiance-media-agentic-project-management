import { NextResponse } from 'next/server';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { generateApiKey, hashApiKey } from '@/lib/api/crypto';
import { newKeyExpiry } from '@/lib/api/key-lifetime';
import { API_ENDPOINT_PERMISSION_SET, permissionLabel, type PermissionKey } from '@/lib/access-control';
import { createApiKeySchema } from '@/lib/schemas/api-keys';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import { listVisibleKeys } from '@/lib/api/key-manage';
import { API_KEY_STATE_FILTERS, parseKeyStateFilter } from '@/lib/api-key-state';

export const dynamic = 'force-dynamic';

/**
 * The keys the signed-in member can see (their own, ones they created, or
 * every key with api_keys.manage_all), newest first, each with its state
 * (active, paused, expired, revoked) and pause fields; never a hash or a
 * connected AI tool's key. ?state= narrows to one state, or to ended
 * (expired and revoked), for the Active, Paused and Ended tabs. counts has
 * every visible key by state, whatever the filter.
 * Answers { data: { keys, counts } }.
 */
export async function GET(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const state = parseKeyStateFilter(new URL(request.url).searchParams.get('state'));
  if (state === undefined) {
    return NextResponse.json({ error: `state must be one of ${API_KEY_STATE_FILTERS.join(', ')}` }, { status: 400 });
  }
  try {
    const data = await listVisibleKeys(service, { memberId, access }, state);
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[API] listing API keys failed', error);
    return NextResponse.json({ error: 'Failed to load API keys' }, { status: 500 });
  }
}

/**
 * Creates an API key for the signed-in member. The key is generated and hashed
 * here, each scope must be an API permission the member holds on the api
 * channel, and the full key is returned once, never stored. expires_in_days
 * (1 to 3650, or null for no expiry) sets when it ends; left out, the
 * workspace's personal key lifetime decides (none until an Owner sets one).
 * For anyone but an Owner that lifetime is also the most they may choose.
 */
export async function POST(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  if (access.role === 'guest') {
    return NextResponse.json({ error: 'Guests cannot create API keys' }, { status: 403 });
  }

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
    return NextResponse.json({ error: `Not available to you: ${refused.map((scope) => `${permissionLabel(scope)} (${scope})`).join(', ')}` }, { status: 422 });
  }

  const expiresAt = await newKeyExpiry(service, memberId, parsed.data.expires_in_days, access);
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
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    })
    .select(API_KEY_COLUMNS)
    .single();
  if (error || !data) return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });

  return NextResponse.json(
    { data: { key: data, secret } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
