import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateTeamMemberSchema } from '@/lib/schemas';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { accessAllows } from '@/lib/api/access';
import { agentRulesColumns } from '@/lib/api/agent-rules';
import { AGENT_RULE_FIELDS, type AgentRulesUpdate } from '@/lib/agent-rules';

export const GET = withApi(async ({ supabase, params, access }) => {
  const selection = accessAllows(access, 'team.manage', 'api')
    ? '*'
    : 'id, name, email, avatar, role, status, timezone, created_at, updated_at';
  const { data, error } = await supabase
    .from('team_members')
    .select(selection)
    .eq('id', params.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Team member');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access }) => {
  const id = params.id;
  const { data: before } = await supabase.from('team_members').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Team member');
  const requested = body as Record<string, unknown>;
  if (before.role === 'owner' && ('role' in requested || 'status' in requested)) {
    throw forbidden('The Owner role and account status are immutable');
  }
  // An Owner's row is changed only with that Owner's own key, and no key makes an Owner.
  if (before.role === 'owner' && id !== teamMemberId) {
    throw forbidden('An Owner is changed only by that Owner', { reason: 'owner_protected' });
  }
  if ('role' in requested && access.role !== 'owner') {
    throw forbidden('Only an Owner can change roles');
  }
  if (requested.role === 'owner') {
    throw forbidden('An API key cannot make anyone an Owner', { reason: 'owner_protected' });
  }
  // A role label is for agents only (the role this save leaves them with).
  if (requested.agent_role && ((requested.role as string | undefined) ?? before.role) !== 'agent') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'A role label is for agent members only', { reason: 'agents_only' });
  }
  // An agent's rules: only for agent members (the role this save leaves them with).
  const rules = await agentRulesColumns(supabase, { id, role: (requested.role as string | undefined) ?? before.role }, requested as AgentRulesUpdate);
  const updates = { ...Object.fromEntries(Object.entries(requested).filter(([field]) => !(AGENT_RULE_FIELDS as string[]).includes(field))), ...rules };

  const { data, error } = await supabase
    .from('team_members')
    .update(updates)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Team member');
  logAudit(supabase, { method: 'PATCH', endpoint: `/api/v1/team-members/${id}`, entityType: 'team_member', entityId: id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success(data);
}, { schema: updateTeamMemberSchema });

// Team members are never deleted: their time, comments and pay history would
// go with them. Removing someone suspends them, which ends their access and
// keeps everything they did.
export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId, access }) => {
  const id = params.id;
  if (access.role !== 'owner') throw forbidden('Only an Owner can remove a team member');
  const { data: before } = await supabase.from('team_members').select('*').eq('id', id).maybeSingle();
  if (!before) throw notFound('Team member');
  if (before.role === 'owner') throw forbidden('The Owner account is immutable');

  const { data, error } = await supabase
    .from('team_members')
    .update({ status: 'suspended' })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) throw error;
  logAudit(supabase, { method: 'DELETE', endpoint: `/api/v1/team-members/${id}`, entityType: 'team_member', entityId: id, apiKeyId, teamMemberId, beforeSnapshot: before, afterSnapshot: data, statusCode: 200 });
  return success({ deleted: false, suspended: true });
});
