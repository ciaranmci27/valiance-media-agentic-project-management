import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { claimTask, MAX_LEASE_MINUTES, releaseClaim, type ClaimActor } from '@/lib/api/claims';
import { hostTaskActor, isHostKey } from '@/lib/api/host-keys';
import { badRequest } from '@/lib/api/errors';

const claimSchema = z.object({
  lease_minutes: z.number().int().min(1).max(MAX_LEASE_MINUTES).optional(),
  /** A host key (agents.host) only: the agent the claim is held for, one it serves. */
  agent_id: z.uuid('agent_id must be an agent id').optional(),
}).strict();

/**
 * Claims the task for the key's member for lease_minutes (default 30, up to
 * 240): "I am working on this". 409 names who holds it and until when.
 * Claiming a task you hold renews it; an unassigned task you may pick up is
 * assigned to you. A host key (agents.host) sends agent_id: the claim is
 * held in that agent's name, by the agent's own rules, for its worker.
 */
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  const { lease_minutes, agent_id } = body as z.infer<typeof claimSchema>;
  let actor: ClaimActor = { supabase, memberId: teamMemberId, access, scopes };
  if (isHostKey(scopes)) actor = await hostTaskActor(supabase, apiKeyId, agent_id, id);
  else if (agent_id && agent_id.toLowerCase() !== teamMemberId) throw badRequest('agent_id is for a host key (agents.host): leave it out', { reason: 'agent_id_host_only' });
  const task = await claimTask(actor, id, lease_minutes);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/claim`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: task, statusCode: 200 });
  return success(task);
}, { schema: claimSchema, optionalBody: true, permission: ['tasks.manage_assigned', 'agents.host'] });

/**
 * Ends the claim: your own, or anyone's with tasks.manage_all. A host key
 * names the agent with ?agent_id= and ends only that agent's claim.
 */
export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access, scopes, searchParams }) => {
  const { id } = params as { id: string };
  let actor: ClaimActor = { supabase, memberId: teamMemberId, access, scopes };
  if (isHostKey(scopes)) actor = await hostTaskActor(supabase, apiKeyId, searchParams.get('agent_id') ?? undefined, id);
  const task = await releaseClaim(actor, id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/claim`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, afterSnapshot: task, statusCode: 200 });
  return success(task);
}, { permission: ['tasks.manage_assigned', 'agents.host'] });
