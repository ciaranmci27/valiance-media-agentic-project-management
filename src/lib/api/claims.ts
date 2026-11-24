import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { isModuleEnabled } from '@/lib/access-control';
import { formatEventTitle } from '@/lib/agent-events';
import { accessAllows } from './access';
import { afterResponse } from './after-response';
import { loadMemberRules } from './agent-rules';
import { ApiError, badRequest, forbidden, notFound } from './errors';

/**
 * Claims (work leases): a member says "I am working on this" for a while, so
 * two agents never work the same task. The database does the atomic part
 * (pm.claim_task, pm.extend_task_claim, pm.release_task_claim); this file
 * decides who may, and says plainly who holds a task when someone else does.
 *
 * Who may claim: a task assigned to them (or whose parent is); an unassigned
 * task when their rules let them pick up work (agents: agent_self_assign, and
 * only AI Ready work, the one value agents pick up), which also assigns it.
 * A task assigned to someone else is theirs to claim, not this member's,
 * except one whose only assignee came from a claim that ran out: that one is
 * back in the pool, and claiming it moves the assignment.
 */

export const DEFAULT_LEASE_MINUTES = 30;
export const MAX_LEASE_MINUTES = 240;

export interface ClaimActor {
  supabase: SupabaseClient;
  memberId: string;
  access: AccessContext;
  scopes: string[];
}

interface Holder {
  member_id: string | null;
  member_name: string | null;
  claimed_at: string | null;
  expires_at: string | null;
}

interface ClaimResult {
  outcome: 'claimed' | 'renewed' | 'extended' | 'released' | 'held' | 'assigned_elsewhere' | 'not_held' | 'not_claimed' | 'not_found';
  task?: Record<string, unknown>;
  holder?: Holder;
  /** release: the holder's assignment went with the claim (the claim had made it). */
  unassigned?: boolean;
}

/** A claim as the API shows it on a task: null when nobody holds a live one. */
export function claimOf(task: Record<string, unknown>, holderName?: string | null) {
  const expires = typeof task.claim_expires_at === 'string' ? task.claim_expires_at : null;
  if (!task.claimed_by || !expires || new Date(expires).getTime() <= Date.now()) return null;
  return {
    member_id: task.claimed_by as string,
    ...(holderName !== undefined ? { member_name: holderName } : {}),
    claimed_at: task.claimed_at ?? null,
    expires_at: expires,
  };
}

/** The live claim on a task with the holder's name, for a task read. */
export async function claimWithName(supabase: SupabaseClient, task: Record<string, unknown>) {
  const claim = claimOf(task);
  if (!claim) return null;
  const { data } = await supabase.from('team_members').select('name').eq('id', claim.member_id).maybeSingle();
  return { ...claim, member_name: (data as { name?: string } | null)?.name ?? null };
}

function heldBy(holder: Holder | undefined) {
  const who = holder?.member_name ?? 'Another member';
  const until = holder?.expires_at ?? 'its claim runs out';
  return new ApiError(409, 'CONFLICT', `${who} is working on this task until ${until}. Pick another task, or try again after that.`, {
    reason: 'claimed_by_other',
    claimed_by: holder?.member_id ?? null,
    claimed_by_name: holder?.member_name ?? null,
    claimed_at: holder?.claimed_at ?? null,
    expires_at: holder?.expires_at ?? null,
  });
}

function leaseOf(minutes: unknown): number {
  if (minutes === undefined || minutes === null) return DEFAULT_LEASE_MINUTES;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LEASE_MINUTES) {
    throw badRequest(`lease_minutes must be a whole number from 1 to ${MAX_LEASE_MINUTES}`);
  }
  return minutes;
}

async function rpc(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (error.code === '22023') throw badRequest(error.message);
    throw error;
  }
  return data as ClaimResult;
}

const assigneesOf = (row: { task_assignees?: { member_id: string }[] | null }) =>
  (row.task_assignees || []).map((a) => a.member_id);

/** Logs work.claimed for an agent, as the typed event the fleet already reads. */
function recordClaimedEvent(actor: ClaimActor, task: Record<string, unknown>) {
  if (actor.access.role !== 'agent' || !isModuleEnabled(actor.access, 'agents')) return;
  const payload = { task_id: task.id as string, task_title: String(task.title ?? 'Untitled').slice(0, 200) || 'Untitled' };
  afterResponse('work.claimed activity', async () => {
    const { error } = await actor.supabase.from('agent_activities').insert({
      agent_id: actor.memberId,
      project_id: task.project_id ?? null,
      activity_type: 'work.claimed',
      title: formatEventTitle('work.claimed', payload),
      description: '',
      reference_type: 'task',
      reference_id: task.id,
      metadata: payload,
    });
    if (error) throw error;
  });
}

/**
 * Claims a task for the actor. Claiming a task you already hold renews it.
 * Returns the task with its claim; throws 409 naming the holder when someone
 * else holds it.
 */
export async function claimTask(actor: ClaimActor, taskId: string, leaseMinutes?: unknown) {
  const lease = leaseOf(leaseMinutes);
  const { supabase, memberId } = actor;
  const { data: task, error } = await supabase
    .from('tasks')
    .select('id, project_id, parent_task_id, status, ai_readiness, claimed_by, claim_expires_at, claim_assigned, task_assignees(member_id)')
    .eq('id', taskId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!task) throw notFound('Task');
  if (task.status === 'done') {
    throw new ApiError(409, 'CONFLICT', 'This task is done. Reopen it before claiming it.', { reason: 'task_done' });
  }

  const assignees = assigneesOf(task);
  let assigned = assignees.includes(memberId);
  if (!assigned && task.parent_task_id) {
    const { data: onParent } = await supabase
      .from('task_assignees')
      .select('member_id')
      .eq('task_id', task.parent_task_id)
      .eq('member_id', memberId)
      .maybeSingle();
    assigned = !!onParent;
  }
  let assign = false;
  if (!assigned) {
    // An assignment made by someone else's claim that ran out is back in the pool.
    const pooled = task.claim_assigned === true && !!task.claimed_by && !!task.claim_expires_at
      && new Date(task.claim_expires_at as string).getTime() <= Date.now()
      && assignees.every((id: string) => id === task.claimed_by);
    if (assignees.length > 0 && !pooled) {
      throw forbidden('This task is assigned to someone else. Only the people on it can claim it.', { reason: 'assigned_to_others' });
    }
    const member = await loadMemberRules(supabase, memberId);
    if (member.isAgent && !member.rules.agent_self_assign) {
      throw forbidden(`${member.name}'s rules do not let it pick up unassigned work. Ask for the task to be assigned to it.`, {
        reason: 'self_assign_off',
        hint: 'An Owner or admin can turn on "Can pick up unassigned work" in the agent\'s rules (Team page, or set_agent_rules).',
      });
    }
    if (member.isAgent && task.ai_readiness !== 'ai_ready') {
      throw forbidden('Agents pick up unassigned work only when it is AI Ready (ai_readiness ai_ready).', { reason: 'not_ai_ready' });
    }
    assign = true;
  }

  const result = await rpc(supabase, 'claim_task', { p_task_id: taskId, p_member_id: memberId, p_lease_minutes: lease, p_assign: assign });
  if (result.outcome === 'not_found') throw notFound('Task');
  if (result.outcome === 'held') throw heldBy(result.holder);
  if (result.outcome === 'assigned_elsewhere') {
    throw forbidden('This task was just assigned to someone else. Only the people on it can claim it.', { reason: 'assigned_to_others' });
  }
  const row = result.task ?? {};
  if (result.outcome === 'claimed') recordClaimedEvent(actor, row);
  return {
    ...row,
    claim: claimOf(row),
    renewed: result.outcome === 'renewed',
    ...(assign ? { assigned_to_you: true } : {}),
  };
}

/** Renews the actor's own claim (a heartbeat). 409 when it is not theirs. */
export async function extendClaim(actor: ClaimActor, taskId: string, leaseMinutes?: unknown) {
  const lease = leaseOf(leaseMinutes);
  const result = await rpc(actor.supabase, 'extend_task_claim', { p_task_id: taskId, p_member_id: actor.memberId, p_lease_minutes: lease });
  if (result.outcome === 'not_found') throw notFound('Task');
  if (result.outcome === 'held') throw heldBy(result.holder);
  if (result.outcome === 'not_held') {
    throw new ApiError(409, 'CONFLICT', 'You do not hold a claim on this task. Claim it first.', { reason: 'not_claimed' });
  }
  const row = result.task ?? {};
  return { ...row, claim: claimOf(row) };
}

/**
 * Ends a claim: the holder's own, or anyone's for a member whose key may
 * manage every task (a stuck claim). Releasing a task nobody holds is a no-op
 * that says so (released: false).
 */
export async function releaseClaim(actor: ClaimActor, taskId: string) {
  const canManageAll = actor.scopes.includes('tasks.manage_all') && accessAllows(actor.access, 'tasks.manage_all', 'api');
  return releaseClaimAs(actor.supabase, actor.memberId, taskId, canManageAll);
}

/** releaseClaim for any caller: `force` is "may manage every task", decided by the caller. */
export async function releaseClaimAs(supabase: SupabaseClient, memberId: string, taskId: string, force: boolean) {
  const result = await rpc(supabase, 'release_task_claim', { p_task_id: taskId, p_member_id: memberId, p_force: force });
  if (result.outcome === 'not_found') throw notFound('Task');
  if (result.outcome === 'held') {
    const who = result.holder?.member_name ?? 'another member';
    throw forbidden(`This claim is ${who}'s. Only they, or someone who may manage every task, can release it.`, {
      reason: 'claim_not_yours',
      claimed_by: result.holder?.member_id ?? null,
      expires_at: result.holder?.expires_at ?? null,
    });
  }
  const row = result.task ?? {};
  return {
    ...row,
    claim: null,
    released: result.outcome === 'released',
    // A task the claim had assigned to its holder goes back unassigned.
    unassigned: result.unassigned === true,
    ...(result.holder ? { released_from: { member_id: result.holder.member_id, member_name: result.holder.member_name } } : {}),
  };
}

/**
 * The best task for the actor to work on next, or null: their assigned work
 * first, then unassigned work they may pick up (see pm.next_task_for_member).
 * An agent picks up unassigned work only with agent_self_assign on and only
 * when it is AI Ready.
 */
export async function nextTask(actor: ClaimActor, projectId: string | null) {
  const { supabase, memberId, access } = actor;
  const readAll = accessAllows(access, 'projects.read_all', 'api');
  const readOwn = accessAllows(access, 'projects.read', 'api');
  if (!readAll && !readOwn) return null;
  const projectIds = readAll ? null : access.project_ids;
  if (projectIds && projectIds.length === 0) return null;
  if (projectId && projectIds && !projectIds.includes(projectId)) {
    throw forbidden('Project scope denied', { reason: 'project_scope', project_id: projectId });
  }
  const member = await loadMemberRules(supabase, memberId);
  const { data, error } = await supabase.rpc('next_task_for_member', {
    p_member_id: memberId,
    p_project_ids: projectIds,
    p_project_id: projectId,
    p_include_unassigned: member.isAgent ? member.rules.agent_self_assign : true,
    p_as_agent: member.isAgent,
  });
  if (error) throw error;
  const pick = (Array.isArray(data) ? data[0] : data) as { task_id: string; assigned: boolean } | undefined;
  if (!pick?.task_id) return null;
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('*, task_assignees(member_id), criteria:task_acceptance_criteria(id, criterion, satisfied, sort_order)')
    .eq('id', pick.task_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (taskError) throw taskError;
  if (!task) return null;
  const { task_assignees, criteria, ...row } = task as Record<string, unknown> & {
    task_assignees?: { member_id: string }[] | null;
    criteria?: { sort_order: number }[] | null;
  };
  return {
    ...row,
    assignee_ids: (task_assignees || []).map((a) => a.member_id),
    acceptance_criteria: (criteria || []).slice().sort((a, b) => a.sort_order - b.sort_order),
    claim: claimOf(row),
    pickup: pick.assigned ? 'assigned' : 'unassigned',
  };
}
