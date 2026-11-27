import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { extendClaim, MAX_LEASE_MINUTES, type ClaimActor } from '@/lib/api/claims';
import { hostTaskActor, isHostKey } from '@/lib/api/host-keys';

const extendSchema = z.object({
  lease_minutes: z.number().int().min(1).max(MAX_LEASE_MINUTES).optional(),
  /** A host key (agents.host) only: the agent whose claim it renews. */
  agent_id: z.uuid('agent_id must be an agent id').optional(),
}).strict();

/**
 * Renews your claim for lease_minutes from now (default 30): the heartbeat a
 * long job sends so its claim does not run out. 409 when you do not hold it.
 * Not written to the audit log: it is called every few minutes and changes
 * nothing but the lease. A host key (agents.host) sends agent_id.
 */
export const POST = withApi(async ({ supabase, params, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { id } = params as { id: string };
  const { lease_minutes, agent_id } = body as z.infer<typeof extendSchema>;
  let actor: ClaimActor = { supabase, memberId: teamMemberId, access, scopes };
  if (isHostKey(scopes)) actor = await hostTaskActor(supabase, apiKeyId, agent_id, id);
  return success(await extendClaim(actor, id, lease_minutes));
}, { schema: extendSchema, optionalBody: true, permission: ['tasks.manage_assigned', 'agents.host'] });
