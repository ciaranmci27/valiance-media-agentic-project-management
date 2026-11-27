import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { revokeKeyTree } from '@/lib/api/key-revoke';
import { assertNotOwnerProtected } from '@/lib/api/key-manage';
import { currentApiVia } from '@/lib/api/request-context';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes a key, as Settings > Developers does for a holder of
 * api_keys.manage_all, and with it every live key it made over the API, and
 * every key those made. A revoke is final (the api_keys_guard trigger refuses
 * to clear it); revoking again answers with the key as it is. Each key
 * revoked gets its own audit row. Answers the key, plus cascaded_revokes:
 * the ids of descendants revoked with it.
 *
 * A key that is not an Owner's never revokes an Owner's key or the key of
 * an agent an Owner manages (403 owner_key_protected); its own keys and the
 * keys it made stay its to revoke.
 *
 * Permission: api_keys.manage_all.
 */
export const POST = withApi<unknown, { id: string }>(async ({ supabase, params, access, apiKeyId, teamMemberId }) => {
  if (!UUID.test(params.id)) throw notFound('API key');
  const { data: found, error: readError } = await supabase.from('api_keys').select('id, permissions').eq('id', params.id).maybeSingle();
  if (readError) throw readError;
  // A connected app's key is not a key here: its person disconnects it in Settings > Account.
  if (!found || found.permissions === 'connection') throw notFound('API key');
  // An Owner's key, or an Owner's agent's key, is revoked only with an Owner's key (403 owner_key_protected).
  await assertNotOwnerProtected(supabase, { memberId: teamMemberId, access, apiKeyId }, params.id);
  const revoked = await revokeKeyTree(supabase, params.id, {
    memberId: teamMemberId,
    apiKeyId,
    endpoint: `/api/v1/api-keys/${params.id}/revoke`,
    via: currentApiVia(),
  });
  const { data, error } = await supabase.from('api_keys').select(API_KEY_COLUMNS).eq('id', params.id).single();
  if (error) throw error;
  return success({ ...(data as unknown as Record<string, unknown>), cascaded_revokes: revoked.filter((id) => id !== params.id) });
}, { permission: 'api_keys.manage_all' });
