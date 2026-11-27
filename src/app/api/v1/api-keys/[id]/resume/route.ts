import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { setKeyPaused } from '@/lib/api/key-manage';
import { currentApiVia } from '@/lib/api/request-context';

/**
 * Resumes a paused key: the same secret works again from its next request.
 * As Settings > Developers does for a holder of api_keys.manage_all.
 * Doing it twice answers the key as it is; a revoked or ended key is 409
 * (key_revoked, key_expired). Audited with the key before and after.
 * Answers the key with its state.
 *
 * A key that is not an Owner's never touches an Owner's key or the key of
 * an agent an Owner manages (403 owner_key_protected; revoke-unused leaves
 * them out); its own keys and the keys it made stay its to manage.
 *
 * Permission: api_keys.manage_all.
 */
export const POST = withApi<unknown, { id: string }>(async ({ supabase, params, access, apiKeyId, teamMemberId }) => {
  const key = await setKeyPaused(supabase, {
    memberId: teamMemberId, access, apiKeyId, endpoint: `/api/v1/api-keys/${params.id}/resume`, via: currentApiVia(), checkManage: false,
  }, params.id, false);
  return success(key);
}, { permission: 'api_keys.manage_all' });
