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
    // Marked as given with a key (given_with_key), so taking it off the last key takes it away again.
    let { error: upsertError } = await service.from('team_member_permissions')
      .upsert(rows.map((row) => ({ ...row, given_with_key: true })), { onConflict: 'member_id,permission_key,access_channel' });
    // A database before 20261127001400 has no marker: given as before.
    if (missingMarker(upsertError)) ({ error: upsertError } = await service.from('team_member_permissions').upsert(rows, { onConflict: 'member_id,permission_key,access_channel' }));
    if (upsertError) throw upsertError;
  }
  return {
    added: rows.map((row) => row.permission_key).filter((scope) => !existing.has(scope)),
    wasDenied: rows.map((row) => row.permission_key).filter((scope) => existing.get(scope) === 'deny'),
  };
}

/** A database before 20261127001400 has no given_with_key column. */
export const missingMarker = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204') && /given_with_key/.test(error.message ?? '');

/**
 * A power given beyond the agent's role with a key lives on its keys: when
 * an edit takes a scope off a workspace agent's key and no other live key of
 * that agent carries it, the allow that a key gave it (given_with_key) goes
 * too, so it never keeps a power nobody can see on a key (and new keys
 * cannot carry it again without an Owner giving it again). What the role
 * gives, a deny, and an allow an Owner set in Team > Roles & permissions
 * stay. Answers the scopes that would go: pass them to
 * removeUncarriedAgentScopeGrants once the edit is written.
 */
export async function uncarriedAgentScopeGrants(service: SupabaseClient, agentId: string, keyId: string, removed: readonly string[]): Promise<string[]> {
  if (removed.length === 0) return [];
  const { data: member, error: memberError } = await service.from('team_members').select('role, delegate_of').eq('id', agentId).maybeSingle();
  if (memberError) throw memberError;
  const row = member as { role?: string; delegate_of?: string | null } | null;
  if (row?.role !== 'agent' || row.delegate_of) return [];
  const [{ data: roleRows, error: roleError }, { data: allows, error: allowError }, { data: keys, error: keysError }] = await Promise.all([
    service.from('role_permissions').select('permission_key').eq('role', 'agent').eq('access_channel', 'api'),
    service.from('team_member_permissions').select('permission_key').eq('member_id', agentId).eq('access_channel', 'api').eq('effect', 'allow')
      .eq('given_with_key', true).in('permission_key', [...removed]),
    service.from('api_keys').select('id, scopes, expires_at').eq('team_member_id', agentId).is('revoked_at', null),
  ]);
  if (roleError) throw roleError;
  // A database before 20261127001400 cannot tell a key's grant from an Owner's: it takes nothing.
  if (missingMarker(allowError)) return [];
  if (allowError) throw allowError;
  if (keysError) throw keysError;
  const byRole = new Set(((roleRows ?? []) as { permission_key: string }[]).map((r) => r.permission_key));
  if (byRole.has('*')) return [];
  const now = Date.now();
  const carried = new Set(((keys ?? []) as { id: string; scopes: string[] | null; expires_at: string | null }[])
    .filter((key) => key.id !== keyId && (!key.expires_at || new Date(key.expires_at).getTime() > now))
    .flatMap((key) => key.scopes ?? []));
  return ((allows ?? []) as { permission_key: string }[]).map((r) => r.permission_key)
    .filter((scope) => !byRole.has(scope) && !carried.has(scope));
}

/** Takes away the agent's own allows for these scopes (uncarriedAgentScopeGrants). */
export async function removeUncarriedAgentScopeGrants(service: SupabaseClient, agentId: string, scopes: readonly string[]): Promise<void> {
  if (scopes.length === 0) return;
  const { error } = await service.from('team_member_permissions').delete()
    .eq('member_id', agentId).eq('access_channel', 'api').eq('effect', 'allow').eq('given_with_key', true).in('permission_key', [...scopes]);
  if (error) throw error;
}

/** Undoes addAgentScopeGrants: the rows it added go, a deny it replaced comes back. */
export async function removeAgentScopeGrants(service: SupabaseClient, agentId: string, given: { added: string[]; wasDenied: string[] }): Promise<void> {
  if (given.added.length) {
    const { error } = await service.from('team_member_permissions').delete()
      .eq('member_id', agentId).eq('access_channel', 'api').in('permission_key', given.added);
    if (error) throw error;
  }
  if (given.wasDenied.length) {
    // The deny comes back as it was: someone's own, not a key's grant.
    const restore = (fields: Record<string, unknown>) => service.from('team_member_permissions').update(fields)
      .eq('member_id', agentId).eq('access_channel', 'api').in('permission_key', given.wasDenied);
    let { error } = await restore({ effect: 'deny', given_with_key: false });
    if (missingMarker(error)) ({ error } = await restore({ effect: 'deny' }));
    if (error) throw error;
  }
}

/**
 * Over the API (create_api_key, update_api_key with give_beyond_role): the
 * scopes among `scopes` a company agent lacks, checked as its Access tab
 * checks them. Only for an active company agent (a personal agent's powers
 * are its person's); never beyond what the calling key may hand on (it
 * carries the scope and its member holds it); an Owner only, never a scope
 * agents never carry (assertMayGiveAgentScopes). Answers the scopes to give
 * with addAgentScopeGrants before the key is written; empty when it lacks
 * none.
 */
export async function apiScopesBeyondRole(
  service: SupabaseClient,
  granter: Granter,
  target: { id: string; role: string; delegateOf: string | null },
  scopes: readonly string[],
): Promise<string[]> {
  if (target.role !== 'agent' || target.delegateOf) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'give_beyond_role is for a company agent: a person, or a personal agent, holds only what their role gives', { reason: 'beyond_role_agents_only' });
  }
  const beyond = await agentScopesBeyondRole(service, granter, target.id, scopes);
  if (beyond.length === 0) return [];
  // What this key may hand on: it carries the scope and its member holds it on the API (agent-setup.ts grantableScopes).
  const held = new Set<string>(apiScopesFor(granter.access));
  const beyondCaller = beyond.filter((scope) => !granter.scopes.includes(scope) || !held.has(scope));
  if (beyondCaller.length) {
    throw forbidden(`A key can only grant scopes it holds itself: ${beyondCaller.join(', ')}`, { reason: 'scope_escalation', beyond_caller: beyondCaller });
  }
  assertMayGiveAgentScopes(granter.access, beyond);
  return beyond;
}
