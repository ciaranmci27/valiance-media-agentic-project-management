import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { createAgentSchema, type CreateAgent } from '@/lib/schemas';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { ApiError } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { appUrlFor, inviteMember, InviteError } from '@/lib/team/invite';

/**
 * Adds an agent to the team, the way the Team page invites one: a login with
 * no password, then pm.add_team_member with the role agent. The role is
 * always agent (any other field is refused), and like the Team page only an
 * Owner adds an agent. Over the API no sign-in link is made: the agent works
 * through keys (POST /api/v1/api-keys). Answers with the member.
 *
 * Permission: team.manage, with the AI agents module on.
 */
export const POST = withApi<CreateAgent>(async ({ supabase, body, access, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  let memberId: string;
  try {
    const { member } = await inviteMember({
      service: supabase,
      access,
      input: { name: body.name, email: body.email, role: 'agent' },
      appUrl: appUrlFor(''),
      inviterName: null,
      withoutSignIn: true,
    });
    memberId = member.id;
  } catch (error) {
    if (error instanceof InviteError) {
      throw new ApiError(error.status, error.status === 403 ? 'FORBIDDEN' : error.status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR', error.message,
        error.status === 403 ? { reason: 'owner_only', hint: 'Only an Owner adds an agent: use a key that belongs to an Owner.' } : undefined);
    }
    throw error;
  }

  const extra = {
    ...(body.title !== undefined ? { title: body.title || null } : {}),
    ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
    ...(body.agent_profile !== undefined ? { agent_profile: body.agent_profile } : {}),
  };
  const query = Object.keys(extra).length > 0
    ? supabase.from('team_members').update(extra).eq('id', memberId).select().single()
    : supabase.from('team_members').select().eq('id', memberId).single();
  const { data, error } = await query;
  if (error) throw error;
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/agents', entityType: 'team_member', entityId: data.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: data, statusCode: 201 });
  return created(data);
}, { schema: createAgentSchema, permission: 'team.manage' });
