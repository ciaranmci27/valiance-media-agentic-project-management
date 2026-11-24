import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { mintForIdentity } from '@/lib/api/delegation';
import { mintDelegationSchema, type MintDelegationInput } from '@/lib/delegation';

/**
 * A delegation token for the person who asked your agent: name their
 * verified account (provider, external_id, workspace_id?). Send the token as
 * the X-Act-For header, with this same key, on each call you make for them:
 * the call may then do only what both your agent and that person may do,
 * and what it makes records them as principal_id. Lasts 15 minutes; shown
 * only here. 403 identity_not_verified, principal_suspended,
 * principal_is_agent or not_an_agent.
 *
 * Permission: agents.act_for.
 */
export const POST = withApi<MintDelegationInput>(async ({ supabase, body, teamMemberId, access, apiKeyId }) => {
  const grant = await mintForIdentity(supabase, { memberId: teamMemberId, access, keyId: apiKeyId }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/delegations', entityType: 'delegation', entityId: grant.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: { principal_id: grant.principal.id, expires_at: grant.expires_at }, statusCode: 201 });
  const response = created(grant);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}, { schema: mintDelegationSchema, permission: 'agents.act_for', returnsSecret: true });
