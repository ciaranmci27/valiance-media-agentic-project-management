import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { currentAiSetup } from '@/lib/api/request-context';
import { checkKeyGrant, insertApiKey } from '@/lib/api/agent-setup';
import { newKeyExpiry } from '@/lib/api/key-lifetime';
import { createMemberApiKeySchema, type CreateMemberApiKey } from '@/lib/schemas';
import { listKeysPage } from '@/lib/api/key-manage';
import { API_KEY_STATE_FILTERS, parseKeyStateFilter } from '@/lib/api-key-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * API keys, as Settings > Developers lists them: never a hash or a secret,
 * each with its state (active, paused, expired, revoked). state narrows the
 * list to one of them, or to ended (expired and revoked); without it, live
 * keys by default and include_revoked=true adds revoked ones.
 *
 * Permission: api_keys.manage_all.
 */
export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const memberId = searchParams.get('member_id');
  if (memberId && !UUID.test(memberId)) throw badRequest('member_id must be a team member id');
  const state = parseKeyStateFilter(searchParams.get('state'));
  if (state === undefined) throw badRequest(`state must be one of ${API_KEY_STATE_FILTERS.join(', ')}`);
  // Connected AI tools' keys (permissions connection) are connections, not keys: never listed.
  const { keys, total } = await listKeysPage(supabase, { memberId, state, includeRevoked: searchParams.get('include_revoked') === 'true', offset, limit });
  return paginated(keys, { page, limit, total });
}, { permission: 'api_keys.manage_all' });

/**
 * Makes an API key for the caller's own member or for an agent, with the
 * same rules as Settings plus the ones that keep a key from handing out more
 * than it has (lib/api/agent-setup.ts): every scope must be held by the
 * key's member and carried by the calling key; a key for anyone but your
 * own member only from an Owner's key, and only for an agent. The new key
 * records the key that made it (created_by_key_id), so revoking that key
 * revokes this one too; a key an AI setup session makes records none, so
 * the setup key's end never takes it down. expires_in_days (1 to 3650, or
 * null for no expiry) sets when it ends; left out, the workspace's lifetime for the member's
 * keys (an agent's, or a person's) decides. Unless the calling key is an
 * Owner's, that lifetime is also the longest it may choose (no expiry, or
 * longer, ends at the lifetime). The full key is in this answer
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
    // A key an AI setup session makes for an agent never hangs off the setup
    // key, or revoking that key later (or once it ends) would take the
    // agent's key down with it (hire_agent's keys have no parent either).
    createdByKeyId: currentAiSetup() ? null : apiKeyId,
    scopes: granted.scopes,
    permissions: body.permissions,
    expiresAt: await newKeyExpiry(supabase, granted.target.id, body.expires_in_days, access),
  });
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/api-keys', entityType: 'api_key', entityId: key.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: key, statusCode: 201 });
  return NextResponse.json({ success: true, data: { key, secret } }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: createMemberApiKeySchema, permission: 'api_keys.manage_all', returnsSecret: true });
