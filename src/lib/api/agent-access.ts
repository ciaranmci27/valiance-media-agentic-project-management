import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { APPROVAL_CHOICES } from '@/lib/questions';
import { firstActiveOwner, ownerGroupIds } from './agent-owners';
import { ApiError, forbidden } from './errors';
import { activeGroupMembers } from './groups';

/**
 * Who may give a company agent work, checked the same way at every door
 * (20261127001000_agent_hierarchy_access.sql). The principle: sub-agents go
 * through their orchestrator.
 *
 * - No skipping levels: an agent with an orchestrator (team_members.orchestrator_id)
 *   takes work from other agents only from its orchestrator (403 not_your_report).
 * - Down the chart only: an agent that has an orchestrator hands work only to its own
 *   reports, never sideways or up (403 not_your_report). Asking another agent
 *   a question or for a review is not handing it work, and an asked agent
 *   linking its run under the run that asked it is an answer (answering).
 * - Agents with no orchestrator, giving or taking, keep today's behaviour.
 * - A person uses an agent directly (assigns it a task, talks to it in chat)
 *   only while it is reachable directly or has no orchestrator (403
 *   agent_not_available, why only_through_orchestrator).
 * - The person the work is for must be in the agent's audience and every
 *   orchestrator's above it (pm.member_may_use_agent), and so must every agent above
 *   it in a chain of runs: the check runs at every hop for the person who
 *   asked (403 agent_not_available, why not_in_audience).
 * - Work with no person (an agent's own) never reaches an agent that has an
 *   audience, unless it comes from that agent's own orchestrator (403
 *   agent_not_available, why needs_person): person-less work cannot be used
 *   to reach a restricted agent.
 * - Ask first (team_members.ask_first): unless the person asking manages it,
 *   the first try makes one approval asked to its managers and nothing runs
 *   (the caller answers 202 with the approval id); trying again while it is
 *   open answers the same approval (one even when two requests race: a
 *   unique index). Only an approval answered by someone who manages the
 *   agent counts. Once approved, the request goes through: a task's approval
 *   covers that task only, a new task's (by title in a project) is used up by
 *   the first task made, a chat conversation's lasts 24 hours. A manager's
 *   reject stands for 24 hours (403 agent_use_declined).
 * - Personal agents keep today's behaviour here (delegate_task has its own
 *   rules for them).
 *
 * A database before the migration has no orchestrators, audiences or ask-first:
 * every check passes, as before. Moving an agent to a new orchestrator changes only
 * where new work may come from; work it already has stays where it is.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/** Where work reaches the agent: what the refusal and the approval name. */
export type AgentEntry = 'assign' | 'chat' | 'mention' | 'delegate' | 'run';

/** How long a chat conversation's approval, and a manager's reject, last. */
export const ASK_FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AgentAccessRow {
  id: string;
  name: string;
  role: string;
  status: string;
  delegate_of: string | null;
  orchestrator_id: string | null;
  reachable_directly: boolean;
  ask_first: boolean;
}

const ACCESS_COLUMNS = 'id, name, role, status, delegate_of, orchestrator_id, reachable_directly, ask_first';
const OLD_COLUMNS = 'id, name, role, status, delegate_of';

/** A column, table or function the database does not have yet (new code before its migration). */
export const missingHierarchy = (error: { code?: string; message?: string } | null) =>
  !!error && (['42703', '42P01', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code ?? '')
    || /orchestrator_id|reachable_directly|ask_first|agent_audience|member_may_use_agent|member_manages_agent|replace_agent_audience/.test(error.message ?? ''));

/** The access fields of these members; before the migration, no orchestrator, reachable and never asking. */
export async function loadAgentAccess(db: SupabaseClient, ids: string[]): Promise<Map<string, AgentAccessRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, AgentAccessRow>();
  if (unique.length === 0) return out;
  const read = (columns: string) => db.from('team_members').select(columns).in('id', unique);
  let { data, error } = await read(ACCESS_COLUMNS);
  if (error && missingHierarchy(error)) ({ data, error } = await read(OLD_COLUMNS));
  if (error && /delegate_of/.test(error.message ?? '')) ({ data, error } = await read('id, name, role, status'));
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    out.set(row.id, {
      id: row.id,
      name: row.name ?? '',
      role: row.role,
      status: row.status ?? 'active',
      delegate_of: row.delegate_of ?? null,
      orchestrator_id: row.orchestrator_id ?? null,
      reachable_directly: row.reachable_directly !== false,
      ask_first: row.ask_first === true,
    });
  }
  return out;
}

/** pm.member_may_use_agent; true on a database before it. */
export async function memberMayUseAgent(db: SupabaseClient, agentId: string, memberId: string): Promise<boolean> {
  const { data, error } = await db.rpc('member_may_use_agent', { p_agent: agentId, p_member: memberId });
  if (error) {
    if (missingHierarchy(error)) return true;
    throw error;
  }
  return data === true;
}

/** pm.member_manages_agent; false on a database before it (nothing asks first there). */
export async function memberManagesAgent(db: SupabaseClient, agentId: string, memberId: string | null | undefined): Promise<boolean> {
  if (!memberId) return false;
  const { data, error } = await db.rpc('member_manages_agent', { p_agent: agentId, p_member: memberId });
  if (error) {
    if (missingHierarchy(error)) return false;
    throw error;
  }
  return data === true;
}

/** Whether the agent has audience rows of its own (it is restricted); false before the update. */
async function hasAudience(db: SupabaseClient, agentId: string): Promise<boolean> {
  const { data, error } = await db.from('agent_audience').select('id').eq('agent_id', agentId).limit(1);
  if (error) {
    if (missingHierarchy(error)) return false;
    throw error;
  }
  return (data ?? []).length > 0;
}

// ── Refusals ─────────────────────────────────────────────────────────────

export type NotAvailableWhy = 'only_through_orchestrator' | 'not_in_audience' | 'needs_person' | 'no_manager' | 'ask_first';

export function agentNotAvailable(agent: Pick<AgentAccessRow, 'id' | 'name'>, why: NotAvailableWhy, extra: Record<string, unknown> = {}): ApiError {
  const words: Record<NotAvailableWhy, { message: string; hint: string }> = {
    only_through_orchestrator: {
      message: `${agent.name} takes work only through its orchestrator.`,
      hint: 'Give the work to its orchestrator instead (get_agent_access names it).',
    },
    not_in_audience: {
      message: `${agent.name} is not available to the person this work is for.`,
      hint: 'Ask one of its managers to add them to who can use it, or pick another agent.',
    },
    needs_person: {
      message: `${agent.name} takes work only for someone who may use it, or from its own orchestrator.`,
      hint: 'Act for the person who asked (X-Act-For), or hand the work to its orchestrator.',
    },
    no_manager: {
      message: `${agent.name} asks its managers first, and it has no one to ask.`,
      hint: 'Ask an Owner to give it an owner, or to turn off Ask first.',
    },
    ask_first: {
      message: `${agent.name} asks its managers first. One of them has been asked to approve this.`,
      hint: 'Try again once they approve.',
    },
  };
  return forbidden(words[why].message, { reason: 'agent_not_available', why, agent_id: agent.id, hint: words[why].hint, ...extra });
}

export function notYourReport(agent: Pick<AgentAccessRow, 'id' | 'name' | 'orchestrator_id'>, orchestratorName: string | null): ApiError {
  return forbidden(`${agent.name} works under ${orchestratorName ?? 'another agent'}: only its orchestrator hands it work.`, {
    reason: 'not_your_report',
    agent_id: agent.id,
    orchestrator_id: agent.orchestrator_id,
    hint: 'Hand the work to its orchestrator, or to an agent that works under you (get_agent_tree shows the chart).',
  });
}

function notDownTheChart(giver: Pick<AgentAccessRow, 'id' | 'name'>, agent: Pick<AgentAccessRow, 'id' | 'name'>): ApiError {
  return forbidden(`${giver.name} works under an orchestrator, so it hands work only to the agents under it, and ${agent.name} is not one of them.`, {
    reason: 'not_your_report',
    agent_id: agent.id,
    hint: 'Do it yourself, hand it to an agent under you, or ask your orchestrator (asking a question or for a review is fine).',
  });
}

function declined(agent: Pick<AgentAccessRow, 'id' | 'name'>, approvalId: string): ApiError {
  return forbidden(`${agent.name}'s managers declined this. Ask again after a day, or ask one of them directly.`, {
    reason: 'agent_use_declined',
    agent_id: agent.id,
    approval_id: approvalId,
  });
}

// ── The check ────────────────────────────────────────────────────────────

/** Who is giving the work: the person it is for, and the agent handing it over (null when a person gives it directly). */
export interface WorkGiver {
  personId: string | null;
  byAgentId: string | null;
}

/** The giver for a caller: a person themselves, or an agent (acting for its principal, or on its own). */
export function workGiverOf(access: AccessContext, memberId: string): WorkGiver {
  if (access.role === 'agent') return { personId: access.principal_id ?? null, byAgentId: memberId };
  return { personId: memberId, byAgentId: null };
}

export interface AgentWorkRequest extends WorkGiver {
  /** The agent receiving the work. */
  agentId: string;
  /** Agents above in a chain of runs, each checked for the person too. */
  chainAgentIds?: string[];
  entry: AgentEntry;
  /** What an approval covers: task:<id>, new:<project>:<title hash>, chat:<connection>:<conversation>. */
  target: string;
  /** What the managers read; false: this door never asks (it only refuses). */
  ask: false | { summary: string; taskId?: string | null; projectId?: string | null };
  /** The receiver answers a question the giver asked it (a run linked under the asking run): not new work, so the chart rules do not apply. */
  answering?: boolean;
  /**
   * A new task's approval this request may use (single use): the gate claims it here (marks it used,
   * so two requests never both use it) and the caller releases it with releaseApprovals when no task
   * was made after all (a later check threw, it became a suggestion, another agent waits). Without it
   * the gate only reads: an approved, unused approval lets the request through and stays unused.
   */
  claimed?: string[];
}

/** An ask-first approval the work waits on. */
export interface AskFirstPending {
  approval_id: string;
  agent_id: string;
  status: 'awaiting_approval';
  reason: 'ask_first';
  asked_to: string | null;
  asked_to_group: string | null;
  message: string;
}

/**
 * Checks one piece of work for one agent. Throws 403 when it may not reach
 * the agent; answers an AskFirstPending when it waits on its managers (the
 * caller answers 202 and does nothing else); null when it may go ahead.
 */
export async function gateAgentWork(db: SupabaseClient, request: AgentWorkRequest): Promise<AskFirstPending | null> {
  if (request.byAgentId && request.byAgentId === request.agentId) return null;
  const chain = (request.chainAgentIds ?? []).filter((id) => id && id !== request.agentId);
  const rows = await loadAgentAccess(db, [request.agentId, ...chain, ...(request.byAgentId ? [request.byAgentId] : [])]);
  const agent = rows.get(request.agentId);
  // Personal agents keep today's behaviour here.
  if (!agent || agent.role !== 'agent' || agent.delegate_of) return null;
  const giver = request.byAgentId ? rows.get(request.byAgentId) ?? null : null;

  if (request.byAgentId && !request.answering) {
    // No skipping levels: an agent with an orchestrator takes work from other agents only from it.
    if (agent.orchestrator_id && agent.orchestrator_id !== request.byAgentId) {
      const orchestrator = (await loadAgentAccess(db, [agent.orchestrator_id])).get(agent.orchestrator_id);
      throw notYourReport(agent, orchestrator?.name ?? null);
    }
    // Down the chart only: an agent that has an orchestrator hands work only to its own reports.
    if (giver?.orchestrator_id && agent.orchestrator_id !== giver.id) throw notDownTheChart(giver, agent);
  } else if (!request.byAgentId && agent.orchestrator_id && !agent.reachable_directly) {
    const orchestrator = (await loadAgentAccess(db, [agent.orchestrator_id])).get(agent.orchestrator_id);
    throw agentNotAvailable(agent, 'only_through_orchestrator', { orchestrator_id: agent.orchestrator_id, orchestrator_name: orchestrator?.name ?? null });
  }

  if (request.personId) {
    // The person it is for, at this agent and every company agent above it in the chain.
    for (const id of [request.agentId, ...chain]) {
      const at = rows.get(id);
      if (!at || at.delegate_of) continue;
      if (!(await memberMayUseAgent(db, id, request.personId))) {
        throw agentNotAvailable(at, 'not_in_audience', id === request.agentId ? {} : { blocked_at: id });
      }
    }
  } else if (request.byAgentId && !request.answering && agent.orchestrator_id !== request.byAgentId && await hasAudience(db, agent.id)) {
    // Person-less work never reaches a restricted agent, except from its own orchestrator.
    throw agentNotAvailable(agent, 'needs_person');
  }

  if (request.ask === false || !agent.ask_first) return null;
  // The person it is for manages the agent: no one to ask.
  if (await memberManagesAgent(db, agent.id, request.personId)) return null;
  return askFirst(db, agent, request, request.ask);
}

/** The key an ask-first approval is found by: the agent, who asked and the work. */
export function askFirstKey(agentId: string, requesterId: string, target: string): string {
  return `${agentId}:${requesterId}:${target}`;
}

/** The target for a new task: its project and its title. */
export function newTaskTarget(projectId: string, title: string): string {
  return `new:${projectId}:${createHash('sha256').update(title.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

const pendingOf = (row: Row, agent: AgentAccessRow): AskFirstPending => ({
  approval_id: row.id,
  agent_id: agent.id,
  status: 'awaiting_approval',
  reason: 'ask_first',
  asked_to: row.asked_to ?? null,
  asked_to_group: row.asked_to_group ?? null,
  message: `${agent.name} asks its managers first. One of them has been asked to approve this; try again once they do.`,
});

/** Who decides: the agent's first active owner, else a group that owns it with a person in it, else the oldest active Owner. Never the requester. */
async function managerToAsk(db: SupabaseClient, agentId: string, exclude: string[]): Promise<{ asked_to: string | null; asked_to_group: string | null } | null> {
  const owner = await firstActiveOwner(db, agentId);
  if (owner && !exclude.includes(owner)) return { asked_to: owner, asked_to_group: null };
  for (const group of await ownerGroupIds(db, agentId)) {
    const people = (await activeGroupMembers(db, group, { peopleOnly: true })).filter((m) => !exclude.includes(m.id));
    if (people.length) return { asked_to: null, asked_to_group: group };
  }
  const { data, error } = await db.from('team_members').select('id').eq('role', 'owner').eq('status', 'active').order('created_at').order('id');
  if (error) throw error;
  const first = ((data ?? []) as Row[]).find((row) => !exclude.includes(row.id));
  return first ? { asked_to: first.id, asked_to_group: null } : null;
}

const APPROVAL_COLUMNS = 'id, status, answer_choice, answered_by, answered_at, asked_to, asked_to_group, expires_at, action, used_at';

async function approvalsFor(db: SupabaseClient, key: string): Promise<Row[]> {
  const { data, error } = await db.from('questions').select(APPROVAL_COLUMNS)
    .eq('kind', 'approval').eq('action->>type', 'agent.use').eq('action->details->>key', key).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  return (data ?? []) as Row[];
}

const within = (iso: string | null | undefined, ms: number) => !!iso && Date.now() - new Date(iso).getTime() < ms;

/**
 * Uses an approved approval when it still covers this request: a task's
 * covers that task (any number of times), a chat conversation's for 24 hours
 * after it was decided, a new task's once (the first use marks it used).
 */
async function useApproval(db: SupabaseClient, row: Row, target: string, claimed: string[] | undefined): Promise<boolean> {
  if (target.startsWith('chat:')) return within(row.answered_at, ASK_FIRST_WINDOW_MS);
  if (!target.startsWith('new:')) return true;
  if (row.used_at) return false;
  if (!claimed) return true;
  // Claimed only if nobody claimed it in between; released again when no task is made.
  const { data, error } = await db.from('questions').update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id');
  if (error) throw error;
  if ((data ?? []).length === 0) return false;
  claimed.push(row.id as string);
  return true;
}

/** Gives back new-task approvals a request claimed but did not use (no task was made). */
export async function releaseApprovals(db: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.from('questions').update({ used_at: null }).in('id', [...new Set(ids)]);
  if (error) console.error('[agents] could not give back an approval', error.code);
  ids.length = 0;
}

async function askFirst(db: SupabaseClient, agent: AgentAccessRow, request: AgentWorkRequest, ask: { summary: string; taskId?: string | null; projectId?: string | null }): Promise<AskFirstPending | null> {
  const requester = request.byAgentId ?? request.personId;
  if (!requester) return null;
  const key = askFirstKey(agent.id, requester, request.target);
  for (const row of await approvalsFor(db, key)) {
    const live = !row.expires_at || new Date(row.expires_at).getTime() > Date.now();
    if (row.status === 'open' && live) return pendingOf(row, agent);
    if (row.status !== 'answered') continue;
    // Only a decision by someone who manages the agent counts.
    if (!(await memberManagesAgent(db, agent.id, row.answered_by))) continue;
    if (row.answer_choice === 'reject') {
      if (within(row.answered_at, ASK_FIRST_WINDOW_MS)) throw declined(agent, row.id);
      break;
    }
    if (row.answer_choice === 'approve') {
      if (await useApproval(db, row, request.target, request.claimed)) return null;
      break;
    }
  }
  const to = await managerToAsk(db, agent.id, [requester, ...(request.personId ? [request.personId] : [])]);
  if (!to) throw agentNotAvailable(agent, 'no_manager');
  const summary = ask.summary.length > 300 ? `${ask.summary.slice(0, 299)}…` : ask.summary;
  const { data: inserted, error: insertError } = await db.from('questions').insert({
    asked_by: requester,
    asked_to: to.asked_to,
    ...(to.asked_to_group ? { asked_to_group: to.asked_to_group } : {}),
    task_id: ask.taskId ?? null,
    project_id: ask.projectId ?? null,
    question: summary,
    choices: [...APPROVAL_CHOICES],
    allow_other: false,
    kind: 'approval',
    action: {
      type: 'agent.use',
      summary,
      details: { key, agent_id: agent.id, agent_name: agent.name, entry: request.entry, for_member_id: request.personId, by_agent_id: request.byAgentId, target: request.target },
    },
    ...(request.byAgentId && request.personId ? { principal_id: request.personId } : {}),
  }).select('id, asked_to, asked_to_group').single();
  if (insertError) {
    // Two requests at once: the other made it (the unique index); answer that one.
    if (insertError.code === '23505') {
      const open = (await approvalsFor(db, key)).find((row) => row.status === 'open');
      if (open) return pendingOf(open, agent);
    }
    throw insertError;
  }
  return pendingOf(inserted as Row, agent);
}

/** Checks several agents for one piece of work (a task's new assignees): the first that waits answers. */
export async function gateAgentsWork(db: SupabaseClient, agentIds: string[], base: Omit<AgentWorkRequest, 'agentId'>): Promise<AskFirstPending | null> {
  for (const agentId of [...new Set(agentIds)]) {
    let pending: AskFirstPending | null;
    try {
      pending = await gateAgentWork(db, { ...base, agentId });
    } catch (error) {
      // Another agent refuses: nothing is made, so what earlier ones claimed goes back.
      if (base.claimed) await releaseApprovals(db, base.claimed);
      throw error;
    }
    if (pending) {
      // Another agent waits: nothing is made, so what earlier ones claimed goes back.
      if (base.claimed) await releaseApprovals(db, base.claimed);
      return pending;
    }
  }
  return null;
}

/**
 * Whether a giver may hand an agent work right now, with no approval asked:
 * for doors that place work for later (a template's planned assignees, a
 * schedule, a repeat) and leave off, with a note, an agent they may not use.
 * An agent that asks first counts as not now unless the person manages it.
 */
export async function mayGiveAgentWork(db: SupabaseClient, agentId: string, giver: WorkGiver): Promise<boolean> {
  try {
    await gateAgentWork(db, { ...giver, agentId, entry: 'assign', target: '', ask: false });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 403) return false;
    throw error;
  }
  const row = (await loadAgentAccess(db, [agentId])).get(agentId);
  if (!row || row.role !== 'agent' || row.delegate_of || !row.ask_first || giver.byAgentId === agentId) return true;
  return memberManagesAgent(db, agentId, giver.personId);
}

/**
 * Approving a suggestion assigns its agent for the approver: checked before
 * any task is made. The assignee is the one approving would set (the
 * request's assigned_to, else the suggestion's). Throws 403; answers the
 * approval it waits on when the agent asks first.
 */
export async function gateSuggestionApproval(
  db: SupabaseClient, access: AccessContext, memberId: string,
  suggestion: { id: string; project_id: string; title?: string | null; assigned_to?: string | null },
  overrideAssignee?: string | null,
): Promise<AskFirstPending | null> {
  const assignee = overrideAssignee || suggestion.assigned_to || null;
  if (!assignee || assignee === memberId) return null;
  return gateAgentWork(db, {
    ...workGiverOf(access, memberId),
    agentId: assignee,
    entry: 'assign',
    target: `suggestion:${suggestion.id}`,
    ask: { summary: `Suggested task "${String(suggestion.title ?? '').slice(0, 200)}"`, projectId: suggestion.project_id },
  });
}

/** The agents among these member ids (one read). */
export async function agentIdsAmong(db: SupabaseClient, ids: string[]): Promise<string[]> {
  const rows = await loadAgentAccess(db, ids);
  return [...rows.values()].filter((row) => row.role === 'agent').map((row) => row.id);
}

/** Tells an agent's managers something (its owners in person, else the active workspace Owners), with a link. */
export async function notifyAgentManagers(db: SupabaseClient, agentId: string, note: { title: string; message: string; link: string; entityType: string; entityId: string }): Promise<void> {
  const { data: owners } = await db.from('agent_owners').select('member_id').eq('agent_id', agentId);
  let ids = ((owners ?? []) as Row[]).map((row) => row.member_id as string);
  if (ids.length) {
    const { data: active } = await db.from('team_members').select('id').in('id', ids).eq('status', 'active');
    ids = ((active ?? []) as Row[]).map((row) => row.id as string);
  }
  if (!ids.length) {
    const { data } = await db.from('team_members').select('id').eq('role', 'owner').eq('status', 'active');
    ids = ((data ?? []) as Row[]).map((row) => row.id as string);
  }
  for (const id of ids) {
    const { error } = await db.rpc('upsert_notification', {
      p_user_id: id, p_title: note.title.slice(0, 200), p_message: note.message.slice(0, 500), p_link: note.link,
      p_entity_type: note.entityType, p_entity_id: note.entityId,
    });
    if (error) console.error('[agents] could not tell a manager', agentId, error.code);
  }
}
