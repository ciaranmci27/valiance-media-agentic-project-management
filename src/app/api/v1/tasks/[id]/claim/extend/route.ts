import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { extendClaim, MAX_LEASE_MINUTES } from '@/lib/api/claims';

const extendSchema = z.object({
  lease_minutes: z.number().int().min(1).max(MAX_LEASE_MINUTES).optional(),
}).strict();

/**
 * Renews your claim for lease_minutes from now (default 30): the heartbeat a
 * long job sends so its claim does not run out. 409 when you do not hold it.
 * Not written to the audit log: it is called every few minutes and changes
 * nothing but the lease.
 */
export const POST = withApi(async ({ supabase, params, body, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  const { lease_minutes } = body as z.infer<typeof extendSchema>;
  return success(await extendClaim({ supabase, memberId: teamMemberId, access, scopes }, id, lease_minutes));
}, { schema: extendSchema, optionalBody: true });
