import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { apiScopesFor } from '@/lib/access-control';
import { isLivePowerKey, mergedPowers, powersOutOfStep, powersPlan } from '@/lib/agent-access-ui';
import type { ApiKey } from '@/lib/types';
import { resolveMemberAccess } from './access';
import { callerHolds, type AgentCaller } from './agent-owners';
import { mayGiveAgentScopes, missingMarker } from './agent-scope-grants';
import { memberApiKeys } from './agent-setup';
import { requireAgentsEnabled } from './agents';
import { insertAuditRows } from './audit';
import { ApiError, forbidden, notFound } from './errors';
import { editApiKey, editApiKeyOverApi } from './key-edit';

/**
 * What a company agent may do, as ONE list (the Access tab's grid,
 * GET/PUT /api/workspace/agents/{id}/powers and /api/v1/agents/{id}/powers).
 *
 * The list is everything its live keys carry plus every power given to it
 * on its own (a per-member allow on the API channel, pm.team_member_permissions).
 * Saving puts exactly the list on every live key, through the key edit's own
 * rules (key-edit.ts: an Owner may give a power the agent's role lacks, which
 * gives it to the agent first; a power a key gave is taken away when no live
 * key carries it), then takes away any own power left out of the list (an
 * Owner only, since an Owner set those). So a key never lacks what the agent
 * was given, and the agent never keeps a power no key shows.
 *
 * Who: whoever manages every API key (api_keys.manage_all) reads and saves;
 * adding a power beyond the agent's role or taking away one an Owner set
 * takes an Owner. A personal assistant's powers are its person's (422
 * personal_agent); a suspended agent's are not changed (422). With no live
 * key there is nothing to save onto (409 no_live_key): make a key first.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const setAgentPowersSchema = z.object({
  /** The whole list of what it may do (permission keys); replaces what its keys carry. */
  scopes: z.array(z.string().min(1).max(100)).min(1, 'Choose at least one thing it may do').max(300),
}).strict();
export type SetAgentPowers = z.infer<typeof setAgentPowersSchema>;

export interface AgentPowersView {
  agent_id: string;
  name: string;
  personal: boolean;
  /** What it may do: one list. */
  scopes: string[];
  /** What it holds now on the API channel (its role and anything given to it): a key may carry these. */
  held: string[];
  /** Powers given to it on its own, beyond or beside its role. */
  given: string[];
  live_keys: { id: string; name: string; scopes: string[] }[];
  /** Some live key lacks part of the list: saving lines them up. */
  out_of_step: boolean;
  /** The caller may save the list. */
  can_edit: boolean;
  /** The caller may add a power the agent's role lacks (an Owner). */
  can_give_beyond_role: boolean;
}

async function loadAgent(db: SupabaseClient, agentId: string): Promise<Row> {
  const { data, error } = await db.from('team_members').select('id, name, role, status, delegate_of').eq('id', agentId).maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  if (!row) throw notFound('Agent');
  if (row.role !== 'agent') throw new ApiError(422, 'VALIDATION_ERROR', `${row.name} is not an agent`, { reason: 'agents_only' });
  return row;
}

/** Its own allows on the API channel (scope and whether a key gave it). */
async function ownAllows(db: SupabaseClient, agentId: string): Promise<{ scope: string; withKey: boolean }[]> {
  const read = (columns: string) => db.from('team_member_permissions').select(columns)
    .eq('member_id', agentId).eq('access_channel', 'api').eq('effect', 'allow');
  let { data, error } = await read('permission_key, given_with_key');
  // A database before 20261127001400 cannot tell a key's grant from an Owner's: every allow counts as an Owner's.
  if (missingMarker(error)) ({ data, error } = await read('permission_key'));
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map((row) => ({ scope: row.permission_key as string, withKey: row.given_with_key === true }));
}

function liveKeys(keys: ApiKey[], now: number): ApiKey[] {
  return keys.filter((key) => key.permissions !== 'connection' && isLivePowerKey(key, now));
}

function mayRead(caller: AgentCaller): void {
  if (!callerHolds(caller, 'api_keys.manage_all')) {
    throw forbidden('Only who manages every API key sees what an agent may do', { reason: 'not_key_manager' });
  }
}

export async function getAgentPowers(db: SupabaseClient, caller: AgentCaller, agentId: string, now: number = Date.now()): Promise<AgentPowersView> {
  requireAgentsEnabled(caller.access);
  const agent = await loadAgent(db, agentId);
  mayRead(caller);
  const [keys, own, access] = await Promise.all([memberApiKeys(db, agentId), ownAllows(db, agentId), resolveMemberAccess(db, agentId)]);
  const live = liveKeys(keys, now);
  const ownScopes = own.map((row) => row.scope);
  const personal = !!agent.delegate_of;
  return {
    agent_id: agent.id,
    name: agent.name,
    personal,
    scopes: mergedPowers(live, ownScopes, now),
    held: access ? (apiScopesFor(access) as string[]) : [],
    given: [...new Set(ownScopes)].sort(),
    live_keys: live.map((key) => ({ id: key.id, name: key.name, scopes: [...(key.scopes ?? [])] })),
    out_of_step: powersOutOfStep(live, ownScopes, now),
    can_edit: !personal && agent.status === 'active' && live.length > 0 && caller.memberId !== agentId,
    can_give_beyond_role: !personal && mayGiveAgentScopes(caller.access),
  };
}

/** How a save reaches the keys: the screens' edit (signed in) or the API's (a calling key). */
export type PowersVia =
  | { kind: 'app' }
  | { kind: 'api'; scopes: string[]; apiKeyId: string; via: 'rest' | 'mcp' | 'app' };

export async function setAgentPowers(
  db: SupabaseClient, caller: AgentCaller, agentId: string, body: SetAgentPowers, via: PowersVia = { kind: 'app' }, now: number = Date.now(),
): Promise<AgentPowersView> {
  requireAgentsEnabled(caller.access);
  const agent = await loadAgent(db, agentId);
  if (caller.memberId === agentId) throw forbidden('An agent never changes what it may do itself', { reason: 'own_powers' });
  mayRead(caller);
  if (agent.delegate_of) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'A personal assistant does what its person allows: its person changes its key on Your assistant', { reason: 'personal_agent' });
  }
  if (agent.status !== 'active') {
    throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} is suspended: reactivate it to change what it may do`, { reason: 'member_suspended' });
  }
  const [keys, own] = await Promise.all([memberApiKeys(db, agentId), ownAllows(db, agentId)]);
  const live = liveKeys(keys, now);
  if (live.length === 0) {
    throw new ApiError(409, 'CONFLICT', `${agent.name} has no working key: make one first, then choose what it may do`, { reason: 'no_live_key' });
  }
  const plan = powersPlan(live, own.map((row) => row.scope), body.scopes, now);
  // An own power that a key did not give was set by an Owner: only an Owner takes it away.
  const ownerSet = own.filter((row) => !row.withKey && plan.ownToRemove.includes(row.scope)).map((row) => row.scope);
  if (ownerSet.length && !mayGiveAgentScopes(caller.access)) {
    throw forbidden(`Only an Owner takes away what an Owner gave ${agent.name}: ${ownerSet.join(', ')}`, { reason: 'scope_needs_owner', not_held: ownerSet });
  }

  // One key at a time, through the key edit's rules: the first carries any refusal before anything else changes.
  for (const keyId of plan.keysToChange) {
    if (via.kind === 'app') {
      const result = await editApiKey(db, { memberId: caller.memberId, access: caller.access }, keyId, { scopes: plan.scopes });
      if (result.status !== 200) {
        const message = (result.body as { error: string }).error;
        throw new ApiError(result.status, result.status === 403 ? 'FORBIDDEN' : result.status === 404 ? 'NOT_FOUND' : result.status === 409 ? 'CONFLICT' : result.status === 422 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message, { reason: 'key_edit_refused', key_id: keyId });
      }
    } else {
      await editApiKeyOverApi(db, { memberId: caller.memberId, access: caller.access, scopes: via.scopes, apiKeyId: via.apiKeyId, via: via.via }, keyId, { scopes: plan.scopes });
    }
  }

  // Whatever own allow is still left out of the list goes (a key's grant may already be gone with its last key).
  const { data: still, error: stillError } = plan.ownToRemove.length
    ? await db.from('team_member_permissions').select('permission_key')
      .eq('member_id', agentId).eq('access_channel', 'api').eq('effect', 'allow').in('permission_key', plan.ownToRemove)
    : { data: [], error: null };
  if (stillError) throw stillError;
  const removing = ((still ?? []) as Row[]).map((row) => row.permission_key as string);
  if (removing.length) {
    const { error } = await db.from('team_member_permissions').delete()
      .eq('member_id', agentId).eq('access_channel', 'api').eq('effect', 'allow').in('permission_key', removing);
    if (error) throw error;
  }
  if (plan.keysToChange.length || removing.length) {
    const { error: auditError } = await insertAuditRows(db, {
      method: 'PUT',
      endpoint: via.kind === 'app' ? `/api/workspace/agents/${agentId}/powers` : `/api/v1/agents/${agentId}/powers`,
      entity_type: 'team_member',
      entity_id: agentId,
      api_key_id: via.kind === 'api' ? via.apiKeyId : null,
      team_member_id: caller.memberId,
      request_body: { scopes: plan.scopes, keys_changed: plan.keysToChange, powers_taken_away: removing },
      status_code: 200,
      ...(via.kind === 'app' ? { via: 'app' } : via.via !== 'rest' ? { via: via.via } : {}),
    });
    if (auditError) console.error('[API] agent powers audit write failed', auditError);
  }
  return getAgentPowers(db, caller, agentId, now);
}
