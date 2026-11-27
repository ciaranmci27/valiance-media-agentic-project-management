import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { editApiKeyOverApi } from '@/lib/api/key-edit';
import { currentApiVia } from '@/lib/api/request-context';
import { updateApiKeyOverApiSchema, type UpdateApiKeyOverApi } from '@/lib/schemas/api-keys';

/**
 * Renames a key and/or replaces its scopes, as Settings > Developers does.
 * The secret stays the same and the change applies from the key's next
 * request. Removing scopes is always allowed; a scope the key does not carry
 * yet is added by minting's rules (lib/api/key-edit.ts): the key's member
 * holds it (422 scope_not_held), the calling key carries it (403
 * scope_escalation), an Owner's key for anyone else's key and only an
 * agent's (403 owner_only, not_an_agent), never a scope agents never carry
 * (422 scope_never_for_agents). give_beyond_role true lets an Owner's key
 * give a company agent a scope its role lacks with the key, as its Access tab
 * does (scopes_given in the answer, logged). A revoked or ended key is 409. Audited with
 * the key before and after. Answers the key with its state.
 *
 * A key that is not an Owner's never touches an Owner's key or the key of
 * an agent an Owner manages (403 owner_key_protected; revoke-unused leaves
 * them out); its own keys and the keys it made stay its to manage.
 *
 * Permission: api_keys.manage_all.
 */
export const PATCH = withApi<UpdateApiKeyOverApi, { id: string }>(async ({ supabase, params, body, access, scopes, apiKeyId, teamMemberId }) => {
  const key = await editApiKeyOverApi(supabase, { memberId: teamMemberId, access, scopes, apiKeyId, via: currentApiVia() }, params.id, body);
  return success(key);
}, { schema: updateApiKeyOverApiSchema, permission: 'api_keys.manage_all' });
