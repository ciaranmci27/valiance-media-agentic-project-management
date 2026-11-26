import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { claimTask, MAX_LEASE_MINUTES, releaseClaim } from '@/lib/api/claims';

const claimSchema = z.object({
  lease_minutes: z.number().int().min(1).max(MAX_LEASE_MINUTES).optional(),
}).strict();

/**
 * Claims the task for the key's member for lease_minutes (default 30, up to
 * 240): "I am working on this". 409 names who holds it and until when.
 * Claiming a task you hold renews it; an unassigned task you may pick up is
 * assigned to you.
 */
export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  const { lease_minutes } = body as z.infer<typeof claimSchema>;
  const task = await claimTask({ supabase, memberId: teamMemberId, access, scopes }, id, lease_minutes);
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/tasks/${id}/claim`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: task, statusCode: 200 });
  return success(task);
}, { schema: claimSchema, optionalBody: true, permission: 'tasks.manage_assigned' });

/** Ends the claim: your own, or anyone's with tasks.manage_all. */
export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access, scopes }) => {
  const { id } = params as { id: string };
  const task = await releaseClaim({ supabase, memberId: teamMemberId, access, scopes }, id);
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/tasks/${id}/claim`, entityType: 'task', entityId: id, apiKeyId, teamMemberId, afterSnapshot: task, statusCode: 200 });
  return success(task);
}, { permission: 'tasks.manage_assigned' });
