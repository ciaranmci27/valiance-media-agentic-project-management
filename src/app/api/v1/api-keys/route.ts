import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { checkKeyGrant, insertApiKey } from '@/lib/api/agent-setup';
import { createMemberApiKeySchema, type CreateMemberApiKey } from '@/lib/schemas';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * API keys, as Settings > Developers lists them: never a hash or a secret.
 * Live keys by default; include_revoked=true adds revoked ones.
 *
 * Permission: api_keys.manage_all.
 */
export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const memberId = searchParams.get('member_id');
  if (memberId && !UUID.test(memberId)) throw badRequest('member_id must be a team member id');
  let query = supabase.from('api_keys').select(API_KEY_COLUMNS, { count: 'exact' });
  if (memberId) query = query.eq('team_member_id', memberId);
  if (searchParams.get('include_revoked') !== 'true') query = query.is('revoked_at', null);
  const { data, count, error } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: 'api_keys.manage_all' });

/**
 * Makes an API key for the caller's own member or for an agent, with the
 * same rules as Settings plus the ones that keep a key from handing out more
 * than it has (lib/api/agent-setup.ts): every scope must be held by the
 * key's member and carried by the calling key; a key for anyone but your
 * own member only from an Owner's key, and only for an agent. The new key
 * records the key that made it (created_by_key_id), so revoking that key
 * revokes this one too. The full key is in this answer
 * only, never stored and never shown again, so the Idempotency-Key header is
 * refused here.
 *
 * Permission: api_keys.manage_all.
 */
export const POST = withApi<CreateMemberApiKey>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId }) => {
  const granted = await checkKeyGrant(supabase, { memberId: teamMemberId, access, scopes }, { memberId: body.member_id, scopes: body.scopes });
  const { key, secret } = await insertApiKey(supabase, {
    name: body.name,
    memberId: granted.target.id,
    createdBy: teamMemberId,
    createdByKeyId: apiKeyId,
    scopes: granted.scopes,
    permissions: body.permissions,
  });
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/api-keys', entityType: 'api_key', entityId: key.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: key, statusCode: 201 });
  return NextResponse.json({ success: true, data: { key, secret } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: createMemberApiKeySchema, permission: 'api_keys.manage_all', returnsSecret: true });
