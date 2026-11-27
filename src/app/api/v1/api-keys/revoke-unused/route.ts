import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { currentApiVia } from '@/lib/api/request-context';
import { revokeUnusedKeys, revokeUnusedSchema, type RevokeUnused } from '@/lib/api/key-hygiene';

/**
 * Revoke unused keys, as Settings > Developers does. { dry_run: true } (the
 * default) answers the keys that were never used (made over a day ago) or
 * not used for 90 days, with why (never_used, stale) and whose they are.
 * { dry_run: false, key_ids } revokes exactly the ids from that preview
 * that are still unused; a key used since is in skipped_ids. Never the
 * calling key, a connected AI tool's key or a one-hour AI setup key. Each
 * revoke is final, takes the keys it made with it, and is audited.
 * Answers { dry_run, days, keys, revoked_ids, skipped_ids }.
 *
 * Permission: api_keys.manage_all.
 */
export const POST = withApi<RevokeUnused>(async ({ supabase, body, access, apiKeyId, teamMemberId }) => {
  return success(await revokeUnusedKeys(supabase, { memberId: teamMemberId, access, apiKeyId, endpoint: '/api/v1/api-keys/revoke-unused', via: currentApiVia() }, body));
}, { schema: revokeUnusedSchema, permission: 'api_keys.manage_all' });
