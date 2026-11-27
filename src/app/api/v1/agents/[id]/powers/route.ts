import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { currentApiVia } from '@/lib/api/request-context';
import { getAgentPowers, setAgentPowers, setAgentPowersSchema, type SetAgentPowers } from '@/lib/api/agent-powers';

/**
 * What a company agent may do, as one list: scopes (everything its live
 * keys carry and every power given to it on its own), held (what a key for
 * it may carry now), given (its own powers), live_keys, out_of_step (some
 * live key lacks part of the list) and can_edit.
 *
 * Permission: api_keys.manage_all, with the AI agents module on.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, teamMemberId }) => {
  return success(await getAgentPowers(supabase, { memberId: teamMemberId, access, scopes }, params.id));
}, { permission: 'api_keys.manage_all' });

/**
 * Replaces what a company agent may do: the list goes on every live key (by
 * minting's rules: the calling key carries each scope it adds, an Owner's
 * key for an agent's key, never a scope agents never carry), and a power
 * given to it on its own that is left out is taken away (one an Owner set:
 * an Owner's key only, 403 scope_needs_owner). 409 no_live_key with no
 * working key; 422 personal_agent for a personal assistant; 422
 * member_suspended. Audited. Answers the list as GET does.
 *
 * Permission: api_keys.manage_all, with the AI agents module on.
 */
export const PUT = withApi<SetAgentPowers, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const caller = { memberId: teamMemberId, access, scopes };
  return success(await setAgentPowers(supabase, caller, params.id, body, { kind: 'api', scopes, apiKeyId, via: currentApiVia() }));
}, { schema: setAgentPowersSchema, permission: 'api_keys.manage_all' });
