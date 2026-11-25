import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { logAudit } from '@/lib/api/audit';
import { claimAssistantKey } from '@/lib/api/personal-agents';
import { assistantKeySchema, type AssistantKeyInput } from '@/lib/personal-agents';

/**
 * The harness collects a personal agent's key, once: 409 key_exists while it
 * has a live one (rotate that instead). The key carries the agent's template
 * scopes (or scopes), narrowed to what the agent holds with its person and
 * this key carries (left_out names the rest), by minting's rules, so this
 * key belongs to an Owner. It records this key, so revoking this key revokes
 * every key it collected. The secret is in this answer only; the
 * Idempotency-Key header is refused. Answers { key, secret, left_out }.
 *
 * Permission: assistants.provision, with the AI agents module on.
 */
export const POST = withApi<AssistantKeyInput, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const made = await claimAssistantKey(supabase, {
    caller: { memberId: teamMemberId, access, scopes },
    granter: { memberId: teamMemberId, access, scopes },
    keyId: apiKeyId,
  }, params.id, body);
  logAudit(supabase, {
    method: 'POST', endpoint: `/api/v1/assistants/${params.id}/key`, entityType: 'api_key', entityId: made.key.id, apiKeyId, teamMemberId,
    requestBody: { agent_id: params.id, scopes: made.key.scopes }, afterSnapshot: made.key, statusCode: 201,
  });
  return NextResponse.json({ success: true, data: made }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: assistantKeySchema, optionalBody: true, permission: 'assistants.provision', returnsSecret: true });
