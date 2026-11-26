import type { SupabaseClient } from '@supabase/supabase-js';
import { apiScopesFor, type AccessContext } from '@/lib/access-control';
import { NEVER_AGENT_SCOPES } from '@/lib/agents-ui';
import { resolveMemberAccess } from './access';
import { newAgentScopes } from './agent-config';
import type { Granter } from './agent-setup';
import { ApiError, forbidden } from './errors';

/**
 * Powers beyond an agent's role. A key carries only what its member holds,
 * so a key for an agent with a power its role lacks (Act for a person,
 * Upload files) first gives that one agent the power: a per-member allow on
 * the API channel, the same row Team > Roles & permissions writes
 * (pm.team_member_permissions). Only who manages access may (an active
 * Owner, as the access route allows), and never the scopes an agent key
 * never carries (NEVER_AGENT_SCOPES).
 *
 * Used by the hire (hireAgent, undone by undoHire) and by making a key for
 * an existing agent: call agentScopesBeyondRole, then
 * assertMayGiveAgentScopes, then addAgentScopeGrants before the key is
 * minted, and removeAgentScopeGrants if what follows fails.
 */

/** Who may give an agent a power beyond its role: who manages access (the access route's rule). */
export function mayGiveAgentScopes(access: AccessContext): boolean {
  return access.role === 'owner' && access.status === 'active';
}

/**
 * The scopes in `scopes` the agent would not hold from its role: a new agent
 * (agentId null) against the agent role's defaults, an existing one against
 * what it holds now on the API channel (its overrides included).
 */
export async function agentScopesBeyondRole(service: SupabaseClient, granter: Granter, agentId: string | null, scopes: readonly string[]): Promise<string[]> {
  const held = agentId
    ? new Set<string>(apiScopesFor(await resolveMemberAccess(service, agentId)))
    : await newAgentScopes(service, granter);
  return [...new Set(scopes)].filter((scope) => !held.has(scope));
}

/** Refuses giving these beyond the agent's role: never-for-agents scopes, and anyone who does not manage access. */
export function assertMayGiveAgentScopes(access: AccessContext, beyond: readonly string[]): void {
  if (beyond.length === 0) return;
  const never = beyond.filter((scope) => (NEVER_AGENT_SCOPES as readonly string[]).includes(scope));
  if (never.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', `An agent key never carries: ${never.join(', ')}`, { reason: 'scope_never_for_agents', not_held: never });
  }
  if (!mayGiveAgentScopes(access)) {
    throw forbidden(`Only an Owner can give agents this: ${beyond.join(', ')}`, {
      reason: 'scope_needs_owner', not_held: [...beyond],
      hint: 'Agents do not hold these by default. An Owner gives them to this agent, or turns them on for the agent role in Team > Roles & permissions.',
    });
  }
}

/**
 * Gives the agent each scope as a per-member allow on the API channel.
 * Answers what this call changed, for removeAgentScopeGrants: rows it added,
 * and rows that said deny before (put back on undo).
 */
export async function addAgentScopeGrants(
  service: SupabaseClient, agentId: string, scopes: readonly string[], createdBy: string | null,
): Promise<{ added: string[]; wasDenied: string[] }> {
  if (scopes.length === 0) return { added: [], wasDenied: [] };
  const { data, error } = await service.from('team_member_permissions').select('permission_key, effect')
    .eq('member_id', agentId).eq('access_channel', 'api').in('permission_key', [...scopes]);
  if (error) throw error;
  const existing = new Map(((data ?? []) as { permission_key: string; effect: string }[]).map((row) => [row.permission_key, row.effect]));
  const rows = scopes.filter((scope) => existing.get(scope) !== 'allow')
    .map((scope) => ({ member_id: agentId, permission_key: scope, access_channel: 'api', effect: 'allow', created_by: createdBy }));
  if (rows.length) {
    const { error: upsertError } = await service.from('team_member_permissions').upsert(rows, { onConflict: 'member_id,permission_key,access_channel' });
    if (upsertError) throw upsertError;
  }
  return {
    added: rows.map((row) => row.permission_key).filter((scope) => !existing.has(scope)),
    wasDenied: rows.map((row) => row.permission_key).filter((scope) => existing.get(scope) === 'deny'),
  };
}

/** Undoes addAgentScopeGrants: the rows it added go, a deny it replaced comes back. */
export async function removeAgentScopeGrants(service: SupabaseClient, agentId: string, given: { added: string[]; wasDenied: string[] }): Promise<void> {
  if (given.added.length) {
    const { error } = await service.from('team_member_permissions').delete()
      .eq('member_id', agentId).eq('access_channel', 'api').in('permission_key', given.added);
    if (error) throw error;
  }
  if (given.wasDenied.length) {
    const { error } = await service.from('team_member_permissions').update({ effect: 'deny' })
      .eq('member_id', agentId).eq('access_channel', 'api').in('permission_key', given.wasDenied);
    if (error) throw error;
  }
}
