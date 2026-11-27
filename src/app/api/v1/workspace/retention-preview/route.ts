import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { retentionPreview, retentionPreviewSchema, type RetentionPreviewKey } from '@/lib/api/data-retention';

export const dynamic = 'force-dynamic';

/**
 * Before a shorter keep period is saved (Keeping data, Keeping the log):
 * about how many rows each new period would remove at the next daily
 * cleanup. Body: the periods being saved, in days (null: forever). Owner
 * only, by role, on a key that carries settings.manage; changes nothing.
 * Answers { rows: { <setting>: count | null } }.
 */
export const POST = withApi<Partial<Record<RetentionPreviewKey, number | null>>>(async ({ supabase, access, body }) => {
  assertOwnerCaller(access, 'changes how long data is kept');
  return success({ rows: await retentionPreview(supabase, body) });
}, { permission: 'settings.manage', schema: retentionPreviewSchema, optionalBody: true });
