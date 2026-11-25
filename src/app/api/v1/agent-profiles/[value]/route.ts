import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { profileRowPatchSchema, updateProfileRow, type ProfileRowPatch } from '@/lib/api/agent-registries';

export const dynamic = 'force-dynamic';

/**
 * Changes an Owner's own profile: label, description, tools (null: every
 * tool), archived (true archives it, false brings it back). A profile agents
 * still use cannot be archived (409 profile_in_use). Code's profiles are not
 * rows (409 registry_key_taken).
 *
 * Permission: team.manage, Owner only, with the AI agents module on.
 */
export const PATCH = withApi<ProfileRowPatch, { value: string }>(async ({ supabase, params, body, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const row = await updateProfileRow(supabase, { memberId: teamMemberId, access }, params.value, body);
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/agent-profiles/${params.value}`, entityType: 'agent_profile', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: row, statusCode: 200 });
  return success(row);
}, { schema: profileRowPatchSchema, permission: 'team.manage' });

/** Archives an Owner's own profile (rows are never deleted), as PATCH with archived true. */
export const DELETE = withApi<unknown, { value: string }>(async ({ supabase, params, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const row = await updateProfileRow(supabase, { memberId: teamMemberId, access }, params.value, { archived: true });
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/agent-profiles/${params.value}`, entityType: 'agent_profile', apiKeyId, teamMemberId, afterSnapshot: row, statusCode: 200 });
  return success(row);
}, { permission: 'team.manage' });
