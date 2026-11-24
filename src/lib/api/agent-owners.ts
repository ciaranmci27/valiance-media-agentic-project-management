import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext, PermissionKey } from '@/lib/access-control';
import type { AgentOwner } from '@/lib/project-agents';
import { accessAllows, apiKeyAllows } from './access';
import { ApiError, forbidden } from './errors';
import { readAll } from './read-all';

/**
 * The people responsible for an agent (pm.agent_owners), and who may manage
 * an agent.
 *
 * - An agent has one or more owners, each a person (never an agent, never
 *   itself). No owner reads as the workspace Owners.
 * - Managing an agent (its name, title, description, role, avatar, rules,
 *   project assignments and instructions) is for a workspace Owner, a member
 *   with team.manage, or one of the agent's owners. An owner changes
 *   assignments only on projects they reach, as anyone does.
 * - Keys are not part of it: minting and revoking an agent's keys keep the
 *   setup API's rules (an Owner's, api_keys.manage_all, scopes the caller
 *   holds; agent-setup.ts checkKeyGrant).
 * - Ownership changes only by an explicit edit, by a workspace Owner or one
 *   of the agent's owners.
 */

/** Who is asking: a signed-in member (app) or a key (api, with its scopes). */
export interface AgentCaller {
  memberId: string;
  access: AccessContext;
  /** The key's scopes on the api channel; null for a signed-in member. */
  scopes: string[] | null;
}

/** Whether the caller holds a permission on its own channel. */
export function callerHolds(caller: AgentCaller, permission: PermissionKey): boolean {
  return caller.scopes === null
    ? accessAllows(caller.access, permission, 'app')
    : apiKeyAllows(caller.access, caller.scopes, permission);
}

/** The channel a caller's project reach is read on. */
export const callerChannel = (caller: AgentCaller): 'app' | 'api' => (caller.scopes === null ? 'app' : 'api');

const missingTable = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message ?? ''));

/** Owners of many agents in two reads, each list oldest first. */
export async function ownersOf(service: SupabaseClient, agentIds: string[]): Promise<Map<string, AgentOwner[]>> {
  const out = new Map<string, AgentOwner[]>();
  const ids = [...new Set(agentIds)];
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  let rows: { agent_id: string; member_id: string }[];
  try {
    // Paged: a page of agents with many owners each can pass the 1000 rows one response holds.
    rows = await readAll((from, to) => service.from('agent_owners').select('agent_id, member_id, created_at').in('agent_id', ids)
      .order('created_at').order('agent_id').order('member_id').range(from, to));
  } catch (error) {
    if (missingTable(error as { code?: string; message?: string })) return out;
    throw error;
  }
  const memberIds = [...new Set(rows.map((row) => row.member_id))];
  if (memberIds.length === 0) return out;
  const { data: members, error: membersError } = await service.from('team_members').select('id, name, avatar').in('id', memberIds);
  if (membersError) throw membersError;
  const byId = new Map(((members ?? []) as { id: string; name: string; avatar: string | null }[]).map((m) => [m.id, m]));
  for (const row of rows) {
    const member = byId.get(row.member_id);
    if (member) out.get(row.agent_id)?.push({ id: member.id, name: member.name, avatar_url: member.avatar || null });
  }
  return out;
}

/** The agents a member owns. */
export async function agentsOwnedBy(service: SupabaseClient, memberId: string): Promise<string[]> {
  try {
    const rows = await readAll<{ agent_id: string }>((from, to) => service.from('agent_owners').select('agent_id').eq('member_id', memberId)
      .order('agent_id').range(from, to));
    return rows.map((row) => row.agent_id);
  } catch (error) {
    if (missingTable(error as { code?: string; message?: string })) return [];
    throw error;
  }
}

export async function isAgentOwner(service: SupabaseClient, agentId: string, memberId: string): Promise<boolean> {
  const { data, error } = await service.from('agent_owners').select('agent_id').eq('agent_id', agentId).eq('member_id', memberId).maybeSingle();
  if (missingTable(error)) return false;
  if (error) throw error;
  return !!data;
}

/** Whether the caller may manage this agent: a workspace Owner, team.manage, or one of its owners. */
export async function canManageAgent(service: SupabaseClient, caller: AgentCaller, agentId: string): Promise<boolean> {
  if (caller.access.role === 'owner' && caller.access.status === 'active') return true;
  if (callerHolds(caller, 'team.manage')) return true;
  if (caller.memberId === agentId) return false;
  return isAgentOwner(service, agentId, caller.memberId);
}

/** canManageAgent, or a 403 that says who may. */
export async function requireManageAgent(service: SupabaseClient, caller: AgentCaller, agentId: string): Promise<void> {
  if (await canManageAgent(service, caller, agentId)) return;
  throw forbidden('Only an Owner, a member with team.manage, or one of this agent\'s owners manages it', {
    reason: 'not_agent_owner',
    hint: 'Ask an Owner or one of the agent\'s owners to make the change, or to add you as an owner.',
  });
}

/** Whether the caller may change who owns this agent: a workspace Owner or one of its owners. */
export async function canChangeOwners(service: SupabaseClient, caller: AgentCaller, agentId: string): Promise<boolean> {
  if (caller.access.role === 'owner' && caller.access.status === 'active') return true;
  return isAgentOwner(service, agentId, caller.memberId);
}

export const AGENT_OWNERS_MAX = 20;

/**
 * Checks a list of owners: active people (never an agent, never the agent
 * itself), deduplicated, at most AGENT_OWNERS_MAX. Throws 422 naming the
 * ones refused.
 */
export async function checkOwnerIds(service: SupabaseClient, agentId: string | null, ownerIds: string[]): Promise<string[]> {
  const ids = [...new Set(ownerIds)];
  if (ids.length > AGENT_OWNERS_MAX) {
    throw new ApiError(422, 'VALIDATION_ERROR', `An agent has at most ${AGENT_OWNERS_MAX} owners`, { reason: 'too_many_owners' });
  }
  if (ids.length === 0) return ids;
  if (agentId && ids.includes(agentId)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'An agent cannot own itself', { reason: 'owner_is_agent', owner_ids: [agentId] });
  }
  const { data, error } = await service.from('team_members').select('id, role, status').in('id', ids);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; role: string; status: string }[];
  const agents = rows.filter((row) => row.role === 'agent').map((row) => row.id);
  if (agents.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'An agent is owned by people, never by another agent', { reason: 'owner_is_agent', owner_ids: agents });
  }
  const active = new Set(rows.filter((row) => row.status === 'active').map((row) => row.id));
  const missing = ids.filter((id) => !active.has(id));
  if (missing.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Every owner must be an active team member', { reason: 'owner_not_active', owner_ids: missing });
  }
  return ids;
}

/** Adds owners (already checked) to an agent; owners it has stay. */
export async function addOwners(service: SupabaseClient, agentId: string, ownerIds: string[], createdBy: string | null): Promise<string[]> {
  if (ownerIds.length === 0) return [];
  const { data: existing, error } = await service.from('agent_owners').select('member_id').eq('agent_id', agentId);
  if (error) throw error;
  const have = new Set(((existing ?? []) as { member_id: string }[]).map((row) => row.member_id));
  const added = ownerIds.filter((id) => !have.has(id));
  if (added.length) {
    // A millisecond apart, so "first owner" (escalation, lists) keeps the order they were named in.
    const at = Date.now();
    const { error: insertError } = await service.from('agent_owners').insert(added.map((member_id, index) => ({
      agent_id: agentId, member_id, created_by: createdBy, created_at: new Date(at + index).toISOString(),
    })));
    if (insertError) throw insertError;
  }
  return added;
}

/**
 * Replaces an agent's owners with exactly these (checked here). The caller
 * must be a workspace Owner or one of its owners. An empty list leaves it
 * with none, which reads as the workspace Owners.
 */
export async function setOwners(service: SupabaseClient, caller: AgentCaller, agentId: string, ownerIds: string[]): Promise<{ added: string[]; removed: string[] }> {
  if (!(await canChangeOwners(service, caller, agentId))) {
    throw forbidden('Only an Owner or one of this agent\'s owners changes who owns it', { reason: 'not_agent_owner' });
  }
  const ids = await checkOwnerIds(service, agentId, ownerIds);
  const { data: existing, error } = await service.from('agent_owners').select('member_id').eq('agent_id', agentId);
  if (error) throw error;
  const have = ((existing ?? []) as { member_id: string }[]).map((row) => row.member_id);
  const removed = have.filter((id) => !ids.includes(id));
  if (removed.length) {
    const { error: deleteError } = await service.from('agent_owners').delete().eq('agent_id', agentId).in('member_id', removed);
    if (deleteError) throw deleteError;
  }
  const added = await addOwners(service, agentId, ids, caller.memberId);
  return { added, removed };
}

/** An agent's first active owner, oldest first; null with none. */
export async function firstActiveOwner(service: SupabaseClient, agentId: string): Promise<string | null> {
  const { data, error } = await service.from('agent_owners').select('member_id, created_at').eq('agent_id', agentId).order('created_at');
  if (missingTable(error) || error) return null;
  const ids = ((data ?? []) as { member_id: string }[]).map((row) => row.member_id);
  if (ids.length === 0) return null;
  const { data: active } = await service.from('team_members').select('id').in('id', ids).eq('status', 'active');
  const live = new Set(((active ?? []) as { id: string }[]).map((row) => row.id));
  return ids.find((id) => live.has(id)) ?? null;
}
