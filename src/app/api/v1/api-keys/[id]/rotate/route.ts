import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { rotateApiKey } from '@/lib/api/key-rotate';
import { currentApiVia } from '@/lib/api/request-context';
import { rotateApiKeySchema, type RotateApiKey } from '@/lib/schemas/api-keys';

/**
 * Replaces a key with overlap: the successor (same member, scopes,
 * permissions and name; its secret in this answer only) and the old key,
 * which keeps working for overlap_hours (default 24, 0 to 168) and then
 * ends: refused as expired at once, then revoked. A key is replaced once.
 * Minting's rules apply (an Owner's key for an agent's key, scopes the
 * calling key carries); a harness key with assistants.provision rotates
 * personal agents' keys only. The Idempotency-Key header is refused because
 * the answer holds a secret. Answers { key, secret, previous }.
 *
 * Permission: api_keys.manage_all, or assistants.provision.
 */
export const POST = withApi<RotateApiKey, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const rotated = await rotateApiKey(supabase, {
    caller: { memberId: teamMemberId, access, scopes },
    granter: { memberId: teamMemberId, access, scopes },
    apiKeyId,
    endpoint: `/api/v1/api-keys/${params.id}/rotate`,
    via: currentApiVia(),
  }, params.id, body);
  return NextResponse.json({ success: true, data: rotated }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: rotateApiKeySchema, optionalBody: true, permission: ['api_keys.manage_all', 'assistants.provision'], returnsSecret: true });
