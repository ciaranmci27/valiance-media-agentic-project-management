import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessContext } from '@/lib/access-control';
import { isModuleEnabled } from '@/lib/access-control';
import { accessAllowsProject, resolveMemberAccess } from './access';
import type { ClaimActor } from './claims';
import { loadAgentStatus } from './agent-status';
import { ApiError, badRequest, forbidden, moduleOff, notFound } from './errors';

/**
 * Host keys (agents.host): the server that runs a set of agents' workers
 * holds one key, an Owner's, bound to those agents (api_keys.host_agent_ids,
 * 20261127002000_agent_runtime.sql). With it, it reads those agents' events
 * (GET /api/v1/events?agents=) and claims, extends and releases tasks, chat
 * messages and conversations for them, the lease held in the agent's name and
 * handed to one of its workers. It never replies, marks anything handled,
 * reads content beyond the feed, or acts for anyone: withApi refuses a host
 * key everywhere agents.host does not open (host_key_only), and here every
 * lease is checked as the agent itself would be (its project reach, its
 * pause, its rules). Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const HOST_KEY_AGENTS_MAX = 200;

/** Whether a key is a host key. */
export const isHostKey = (scopes: string[]) => scopes.includes('agents.host');

const missing = (error: { code?: string; message?: string } | null) =>
  !!error && (['42703', 'PGRST204'].includes(error.code ?? '') || /host_agent_ids/.test(error.message ?? ''));

function pending(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Host keys work once the database update 20261127002000_agent_runtime.sql is applied', { reason: 'migration_pending' });
}

/** The agents a host key serves (empty when none are bound). */
export async function hostAgentIds(db: SupabaseClient, apiKeyId: string): Promise<string[]> {
  const { data, error } = await db.from('api_keys').select('host_agent_ids').eq('id', apiKeyId).maybeSingle();
  if (error) {
    if (missing(error)) throw pending();
    throw error;
  }
  return Array.isArray((data as Row | null)?.host_agent_ids) ? (data as Row).host_agent_ids as string[] : [];
}

/**
 * The agents a host request names, each one the key serves: the list sent,
 * or every bound agent when none is. 403 agent_not_bound names the rest.
 */
export async function hostAgentsFor(db: SupabaseClient, apiKeyId: string, asked: string[] | null): Promise<string[]> {
  const bound = await hostAgentIds(db, apiKeyId);
  if (bound.length === 0) {
    throw forbidden('This host key serves no agents yet', { reason: 'no_host_agents', hint: 'An Owner binds it to agents with PUT /api/v1/api-keys/{id}/agents.' });
  }
  if (!asked) return bound;
  const refused = asked.filter((id) => !bound.includes(id.toLowerCase()));
  if (refused.length) {
    throw forbidden('This host key does not serve every agent named', { reason: 'agent_not_bound', agent_ids: refused, hint: 'Name only agents bound to this key.' });
  }
  return asked.map((id) => id.toLowerCase());
}

export interface HostedAgent {
  memberId: string;
  access: AccessContext;
}

/**
 * The agent a host request acts for: agent_id sent, bound to the key,
 * active, its module on and not paused (423 as its own key would get). The
 * lease is checked with the agent's own access.
 */
export async function hostedAgent(db: SupabaseClient, apiKeyId: string, agentId: string | undefined): Promise<HostedAgent> {
  if (!agentId) throw badRequest('A host key names the agent the lease is for: send agent_id', { reason: 'agent_id_required' });
  const [id] = await hostAgentsFor(db, apiKeyId, [agentId]);
  const access = await resolveMemberAccess(db, id);
  if (!access || access.role !== 'agent') throw notFound('Agent');
  if (access.status !== 'active') throw forbidden('That agent is suspended', { reason: 'member_suspended' });
  if (!isModuleEnabled(access, 'agents')) throw moduleOff('agents');
  const status = await loadAgentStatus(db, id);
  if (status.paused) {
    throw new ApiError(423, 'AGENT_PAUSED', 'That agent is paused: nothing is handed to its workers until it is resumed.', {
      reason: status.paused_reason ?? 'agent_paused',
      paused_at: status.paused_at,
    });
  }
  return { memberId: id, access };
}

/**
 * The claim actor for a host key leasing a task for one of its agents: the
 * agent itself (its rules, its claim limit), only on a task in a project the
 * agent reaches (else the task reads as missing). It may release only the
 * agent's own claim.
 */
export async function hostTaskActor(db: SupabaseClient, apiKeyId: string, agentId: string | undefined, taskId: string): Promise<ClaimActor> {
  const agent = await hostedAgent(db, apiKeyId, agentId);
  const { data, error } = await db.from('tasks').select('project_id').eq('id', taskId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data || !accessAllowsProject(agent.access, (data as Row).project_id, 'api')) {
    throw new ApiError(404, 'NOT_FOUND', 'Task not found. It may be in Trash.', { reason: 'not_found_or_in_trash', resource: 'task' });
  }
  return { supabase: db, memberId: agent.memberId, access: agent.access, scopes: [] };
}

export const setHostAgentsSchema = z.object({
  agent_ids: z.array(z.uuid('agent_ids holds agent ids')).max(HOST_KEY_AGENTS_MAX, `A host key serves at most ${HOST_KEY_AGENTS_MAX} agents`),
}).strict();
export type SetHostAgents = z.infer<typeof setHostAgentsSchema>;

/** A host key's agents, named. */
export async function hostKeyView(db: SupabaseClient, keyId: string) {
  const ids = await hostAgentIds(db, keyId);
  const { data, error } = ids.length ? await db.from('team_members').select('id, name, status').in('id', ids) : { data: [], error: null };
  if (error) throw error;
  const byId = new Map(((data ?? []) as Row[]).map((row) => [row.id, row]));
  return {
    key_id: keyId,
    agent_ids: ids,
    agents: ids.map((id) => ({ id, name: byId.get(id)?.name ?? '', status: byId.get(id)?.status ?? 'active' })),
  };
}

async function loadHostKey(db: SupabaseClient, keyId: string): Promise<Row> {
  const { data, error } = await db.from('api_keys').select('id, team_member_id, scopes, revoked_at').eq('id', keyId).maybeSingle();
  if (error) throw error;
  if (!data || (data as Row).revoked_at) throw notFound('API key');
  return data as Row;
}

/**
 * Reads or binds a host key's agents. Only an Owner, and only for a live
 * key that carries agents.host and belongs to an Owner. Every agent must be
 * an active agent (company or personal). Replaces the list.
 */
export async function setHostKeyAgents(db: SupabaseClient, caller: { access: AccessContext }, keyId: string, body: SetHostAgents) {
  await assertHostKeyOwner(db, caller, keyId);
  const ids = [...new Set(body.agent_ids.map((id) => id.toLowerCase()))];
  if (ids.length) {
    const { data, error } = await db.from('team_members').select('id, role, status').in('id', ids);
    if (error) throw error;
    const agents = new Set(((data ?? []) as Row[]).filter((row) => row.role === 'agent' && (row.status ?? 'active') === 'active').map((row) => row.id));
    const refused = ids.filter((id) => !agents.has(id));
    if (refused.length) throw new ApiError(422, 'VALIDATION_ERROR', 'Every id must be an active agent', { reason: 'not_an_agent', agent_ids: refused });
  }
  const { error } = await db.from('api_keys').update({ host_agent_ids: ids }).eq('id', keyId);
  if (error) {
    if (missing(error)) throw pending();
    throw error;
  }
  return hostKeyView(db, keyId);
}

export async function assertHostKeyOwner(db: SupabaseClient, caller: { access: AccessContext }, keyId: string): Promise<void> {
  if (caller.access.role !== 'owner') {
    throw forbidden('Only an Owner binds a host key to agents', { reason: 'owner_only' });
  }
  const key = await loadHostKey(db, keyId);
  if (!Array.isArray(key.scopes) || !key.scopes.includes('agents.host')) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Only a key that carries agents.host serves agents', { reason: 'not_a_host_key', hint: 'Make a key with the scope agents.host (and nothing else) first.' });
  }
  const { data: holder, error } = await db.from('team_members').select('role').eq('id', key.team_member_id).maybeSingle();
  if (error) throw error;
  if ((holder as Row | null)?.role !== 'owner') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'A host key must be an Owner\'s key', { reason: 'host_key_not_owner' });
  }
}
