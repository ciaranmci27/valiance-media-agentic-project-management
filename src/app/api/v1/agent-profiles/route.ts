import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { createProfileRow, listAgentProfiles, profileRowInputSchema, type ProfileRowInput } from '@/lib/api/agent-registries';

export const dynamic = 'force-dynamic';

/**
 * Every agent profile (which MCP tools an agent sees): core's (generic), the
 * install's from src/custom/agent-profiles.ts, then an Owner's own rows,
 * each with source (core, install or workspace) and tools (null: every tool
 * its keys allow). include_archived=true adds archived rows.
 *
 * Permission: team.read, with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, searchParams, access }) => {
  requireAgentsEnabled(access);
  return success(await listAgentProfiles(supabase, searchParams.get('include_archived') === 'true'));
}, { permission: 'team.read' });

/**
 * Adds an Owner's own profile (a row): value, label, description and tools
 * (MCP tool names; null or left out for every tool its keys allow). A value
 * code holds is 409 registry_key_taken; a tool that does not exist is 422.
 *
 * Permission: team.manage, Owner only, with the AI agents module on.
 */
export const POST = withApi<ProfileRowInput>(async ({ supabase, body, access, teamMemberId, apiKeyId }) => {
  requireAgentsEnabled(access);
  const row = await createProfileRow(supabase, { memberId: teamMemberId, access }, body);
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agent-profiles', entityType: 'agent_profile', apiKeyId, teamMemberId, requestBody: body, afterSnapshot: row, statusCode: 201 });
  return created(row);
}, { schema: profileRowInputSchema, permission: 'team.manage' });
