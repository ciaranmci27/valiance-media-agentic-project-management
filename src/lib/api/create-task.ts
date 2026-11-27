import { assertProjectWritable } from './request-gate';
import { currentPausedProjectIds } from './request-context';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/api/audit';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { requireAssistantSwitch } from './assistant';
import type { AccessContext } from '@/lib/access-control';
import { badRequest, forbidden, notFound } from '@/lib/api/errors';
import { assertAssigneesCanOpenProject, assertBlockersInProject, assertGoalInProject } from '@/lib/api/task-guards';
import { assertCanManageParent, loadParentTask, nextSubtaskOrder, subtaskRuleError } from '@/lib/api/subtasks';
import { insertComment, insertTask, insertTaskSuggestion } from '@/lib/supabase/queries';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { assertInitiativeInProject, assertSubtaskInitiative } from '@/lib/api/initiatives';
import { applyClosePolicy, commentSentToReview, loadMemberRules, sentToReviewNote, type MemberRules } from '@/lib/api/agent-rules';
import { agentIdsAmong, gateAgentWork, gateAgentsWork, loadAgentAccess, newTaskTarget, releaseApprovals, workGiverOf, type AskFirstPending } from '@/lib/api/agent-access';

interface CreateTaskContext {
  supabase: SupabaseClient;
  body: unknown;
  apiKeyId: string;
  teamMemberId: string;
  access: AccessContext;
  scopes: string[];
  /** The agents it is assigned to were already checked (agent-access.ts) by the caller (delegate_task). */
  agentsChecked?: boolean;
}

/** Who a task is created as: their client, member, access, and whether they may assign others. */
export interface TaskActor {
  supabase: SupabaseClient;
  memberId: string;
  access: AccessContext;
  canAssignOthers: boolean;
  /** Which of the member's permissions apply: their API ones (a key) or their app ones (a person in the app). */
  channel?: 'api' | 'app';
  /** The agents it is assigned to were already checked (agent-access.ts). */
  agentsChecked?: boolean;
}

/**
 * A task created through the API key: on a project the key may open, assigned
 * to the key's member unless the key may assign others, with its criteria and
 * blockers. endpoint names the route in the audit log.
 */
export async function createApiTask({ supabase, body, apiKeyId, teamMemberId, access, scopes, agentsChecked }: CreateTaskContext, endpoint: string) {
  const canAssignOthers = scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
  const task = await createTaskAs({ supabase, memberId: teamMemberId, access, canAssignOthers, agentsChecked }, body);
  logAudit(supabase, { method: 'POST', endpoint, entityType: 'task', entityId: task.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: task, statusCode: 201 });
  return task;
}

/**
 * A task created as a member with API access: on a project they may open,
 * assigned to them unless they may assign others, with its criteria and
 * blockers. The body is createTaskSchema's; with parent_task_id it is a
 * subtask of a task they may manage, in that task's project.
 */
export async function createTaskAs({ supabase, memberId: teamMemberId, access, canAssignOthers, channel = 'api', agentsChecked }: TaskActor, body: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by createTaskSchema by the caller
  const { assignee_ids, acceptance_criteria, blocked_by_ids, source_note, parent_task_id, ...taskData } = body as any;
  let sortOrder: number | undefined;
  let holdsParent = false;
  if (parent_task_id) {
    const parent = await loadParentTask(supabase, parent_task_id, access, channel);
    holdsParent = parent.assignee_ids.includes(teamMemberId);
    if (taskData.project_id && taskData.project_id !== parent.project_id) {
      throw badRequest("A subtask is always in its parent task's project: leave out project_id, or send the parent's");
    }
    assertCanManageParent(parent, teamMemberId, canAssignOthers);
    taskData.project_id = parent.project_id;
    sortOrder = await nextSubtaskOrder(supabase, parent.id);
  }
  if (!taskData.project_id || !accessAllowsProject(access, taskData.project_id, channel)) {
    throw forbidden('Project scope denied');
  }
  const { data: liveProject } = await supabase
    .from('projects')
    .select('id')
    .eq('id', taskData.project_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!liveProject) throw notFound('Project');
  const requestedAssignees = Array.isArray(assignee_ids) ? assignee_ids : [];
  if (!canAssignOthers && requestedAssignees.some((id: string) => id !== teamMemberId)) {
    throw forbidden('This API key can only assign newly created tasks to its own member');
  }
  const effectiveAssignees = canAssignOthers ? requestedAssignees : [teamMemberId];
  await assertAssigneesCanOpenProject(supabase, effectiveAssignees.filter(Boolean), taskData.project_id);
  // A sub-agent (one with an orchestrator) takes on new work of its own only when a manager let it pick up
  // work. Breaking down a task it already holds into subtasks is its own work, and always allowed.
  if (access.role === 'agent' && effectiveAssignees.includes(teamMemberId) && !(parent_task_id && holdsParent)) {
    const me = (await loadAgentAccess(supabase, [teamMemberId])).get(teamMemberId);
    if (me?.orchestrator_id && !me.delegate_of) {
      const rules = await loadMemberRules(supabase, teamMemberId);
      if (rules.isAgent && !rules.rules.agent_self_assign) {
        throw forbidden(`${rules.name} works under an orchestrator and does not take on new work of its own. Its orchestrator hands it work.`, {
          reason: 'self_assign_off',
          hint: canAssignOthers
            ? 'Leave yourself off the new task (give it to an agent under you), add it as a subtask of a task you are on, or ask a manager to turn on "Can pick up unassigned work" for you.'
            : 'Your key makes tasks only for yourself: add it as a subtask of a task you are on, ask your orchestrator to make the task, or ask a manager to turn on "Can pick up unassigned work" for you.',
        });
      }
    }
  }
  // A new task's approval it uses is given back if no task is made after all.
  const claimed: string[] = [];
  if (!agentsChecked) {
    // The agents it goes to: their orchestrator, who can use them, ask first. This door cannot answer 202, so it refuses instead.
    const pending = await gateNewTaskAgents(supabase, access, teamMemberId, effectiveAssignees.filter(Boolean), taskData.project_id, String(taskData.title ?? ''), parent_task_id ?? null, claimed);
    if (pending) {
      throw forbidden(pending.message, { reason: 'agent_not_available', why: 'ask_first', approval_id: pending.approval_id, agent_id: pending.agent_id });
    }
  }
  try {
    return await insertTaskChecked();
  } catch (error) {
    await releaseApprovals(supabase, claimed);
    throw error;
  }

  async function insertTaskChecked() {
  const blockedByIds: string[] = Array.isArray(blocked_by_ids) ? blocked_by_ids : [];
  if (blockedByIds.length > 0) {
    await assertBlockersInProject(supabase, blockedByIds, taskData.project_id);
  }
  if (taskData.project_goal_id) {
    await assertGoalInProject(supabase, taskData.project_goal_id, taskData.project_id);
  }
  // A subtask takes its parent's initiative (the database sets it); naming another is refused.
  if (parent_task_id) {
    await assertSubtaskInitiative(supabase, parent_task_id, taskData.initiative_id);
    delete taskData.initiative_id;
  } else if (taskData.initiative_id) {
    await assertInitiativeInProject(supabase, taskData.initiative_id, taskData.project_id);
  }
  const criteria: string[] = Array.isArray(acceptance_criteria) ? acceptance_criteria : [];
  try {
    return await insertTask(
      supabase,
      {
        ...taskData,
        ...(parent_task_id ? { parent_task_id, sort_order: sortOrder } : {}),
        created_by: teamMemberId || null,
        created_note: source_note ?? null,
        // An incident key's first occurrence is now.
        ...(taskData.dedupe_key ? { last_occurred_at: new Date().toISOString() } : {}),
      },
      effectiveAssignees,
      criteria,
      blockedByIds
    );
  } catch (error) {
    throw subtaskRuleError(error);
  }
  }
}

/**
 * The agents a new task goes to (all but its creator), checked by
 * agent-access.ts: answers the approval it waits on when one asks first.
 * A new task's approval it may use is claimed into `claimed`; the caller
 * gives it back (releaseApprovals) when no task is made after all.
 */
export async function gateNewTaskAgents(supabase: SupabaseClient, access: AccessContext, memberId: string, assigneeIds: string[], projectId: string, title: string, parentTaskId: string | null | undefined, claimed: string[]): Promise<AskFirstPending | null> {
  const agents = (await agentIdsAmong(supabase, assigneeIds)).filter((id) => id !== memberId);
  if (agents.length === 0) return null;
  return gateAgentsWork(supabase, agents, {
    ...workGiverOf(access, memberId),
    entry: 'assign',
    target: newTaskTarget(projectId, title),
    ask: { summary: `New task "${title.slice(0, 200)}"`, taskId: parentTaskId ?? null, projectId },
    claimed,
  });
}

/** What POST /api/v1/tasks answered: a new task, a repeat on an open one, or a suggestion to approve. */
export interface RuledCreate {
  status: 200 | 201 | 202;
  data: Record<string, unknown>;
}

const OPEN_KEY_INDEX = 'tasks_open_dedupe_key';
const isOpenKeyConflict = (error: unknown) => {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  return code === '23505' && (message ?? '').includes(OPEN_KEY_INDEX);
};

/**
 * Counts a repeat on the open task holding the incident key in the project,
 * with the caller's note as a comment. Null when no open task holds it.
 */
async function recordOccurrence(supabase: SupabaseClient, projectId: string, dedupeKey: string, note: string | undefined, memberId: string) {
  const { data, error } = await supabase.rpc('record_task_occurrence', { p_project_id: projectId, p_dedupe_key: dedupeKey });
  if (error) throw error;
  const task = data as Record<string, unknown> | null;
  if (!task?.id) return null;
  if (note) await insertComment(supabase, task.id as string, memberId, note);
  const { data: assignees } = await supabase.from('task_assignees').select('member_id').eq('task_id', task.id as string);
  return { ...task, assignee_ids: ((assignees ?? []) as { member_id: string }[]).map((a) => a.member_id), deduplicated: true };
}

/** The project a create lands in: its own, or its parent task's for a subtask. */
async function targetProject(supabase: SupabaseClient, body: Record<string, unknown>, access: AccessContext): Promise<string> {
  if (typeof body.parent_task_id === 'string') {
    const parent = await loadParentTask(supabase, body.parent_task_id, access);
    if (body.project_id && body.project_id !== parent.project_id) {
      throw badRequest("A subtask is always in its parent task's project: leave out project_id, or send the parent's");
    }
    return parent.project_id;
  }
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  if (!projectId || !accessAllowsProject(access, projectId, 'api')) throw forbidden('Project scope denied');
  return projectId;
}

const approvalNote = (member: MemberRules) =>
  `Sent for approval: ${member.name}'s rules need someone to approve its new tasks. It becomes a task once approved in Suggestions.`;

const withoutEmpty = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== null && !(Array.isArray(field) && field.length === 0)));

/**
 * An agent whose create policy is approval: the task becomes a suggestion in
 * the suggestions queue, carrying what the approve flow copies onto the task
 * (criteria, who does it, the incident key) and the rest of the request in
 * metadata.requested. The same incident key while a suggestion waits counts
 * a repeat on it instead.
 */
export async function suggestInstead(ctx: CreateTaskContext, member: MemberRules, body: Record<string, unknown>, endpoint: string, extraMetadata: Record<string, unknown>, canAssign?: boolean): Promise<RuledCreate> {
  const { supabase, apiKeyId, teamMemberId, access, scopes } = ctx;
  requireAgentsEnabled(access);
  // canAssign: a caller that settled it already (a triage plan, by the member's permission on its channel).
  const canAssignOthers = canAssign ?? (scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api'));
  const projectId = await targetProject(supabase, body, access);
  if (typeof body.parent_task_id === 'string') {
    assertCanManageParent(await loadParentTask(supabase, body.parent_task_id, access), teamMemberId, canAssignOthers);
  }
  const { data: liveProject } = await supabase.from('projects').select('id').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (!liveProject) throw notFound('Project');
  if (typeof body.project_goal_id === 'string') await assertGoalInProject(supabase, body.project_goal_id, projectId);
  if (typeof body.parent_task_id !== 'string' && typeof body.initiative_id === 'string') await assertInitiativeInProject(supabase, body.initiative_id, projectId);
  const requested = Array.isArray(body.assignee_ids) ? (body.assignee_ids as string[]) : [];
  if (!canAssignOthers && requested.some((id) => id !== teamMemberId)) {
    throw forbidden('This API key can only assign newly created tasks to its own member');
  }
  const assignee = canAssignOthers ? requested[0] ?? null : teamMemberId;
  if (assignee) await assertAssigneesCanOpenProject(supabase, [assignee], projectId);
  // An agent it names must be one the proposer may give work to (approving it is checked again, for the approver).
  if (assignee && assignee !== teamMemberId) {
    await gateAgentWork(supabase, { ...workGiverOf(access, teamMemberId), agentId: assignee, entry: 'assign', target: `suggestion:${projectId}`, ask: false });
  }

  const note = approvalNote(member);
  const dedupeKey = typeof body.dedupe_key === 'string' ? body.dedupe_key : null;
  if (dedupeKey) {
    const { data: waiting, error } = await supabase
      .from('task_suggestions')
      .select('*')
      .eq('project_id', projectId)
      .in('status', ['pending', 'needs_info'])
      .eq('metadata->>dedupe_key', dedupeKey)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (waiting) {
      const metadata = (waiting.metadata ?? {}) as Record<string, unknown>;
      const occurrences = (typeof metadata.occurrences === 'number' ? metadata.occurrences : 1) + 1;
      const { data: updated, error: updateError } = await supabase
        .from('task_suggestions')
        .update({ metadata: { ...metadata, occurrences, last_occurred_at: new Date().toISOString() } })
        .eq('id', waiting.id)
        .select()
        .single();
      if (updateError) throw updateError;
      return { status: 202, data: { ...updated, needs_approval: true, deduplicated: true, note } };
    }
  }

  const suggestion = await insertTaskSuggestion(supabase, {
    project_id: projectId,
    goal_id: typeof body.project_goal_id === 'string' ? body.project_goal_id : null,
    proposed_by: teamMemberId,
    assigned_to: assignee,
    title: String(body.title),
    description: typeof body.description === 'string' ? body.description : '',
    reasoning: typeof body.source_note === 'string' ? body.source_note : `Created by ${member.name}. Its rules need approval for new tasks.`,
    priority: (body.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined) ?? 'medium',
    effort_estimate: null,
    task_type: (body.task_type as TaskSuggestionInput['task_type']) ?? null,
    status: 'pending',
    metadata: withoutEmpty({
      source: 'create_task',
      ai_readiness_recommendation: body.ai_readiness,
      acceptance_criteria: body.acceptance_criteria,
      dedupe_key: dedupeKey,
      ...extraMetadata,
      requested: withoutEmpty({
        status: body.status,
        due_date: body.due_date,
        tags: body.tags,
        assignee_ids: requested,
        blocked_by_ids: body.blocked_by_ids,
        parent_task_id: body.parent_task_id,
        initiative_id: body.initiative_id,
      }),
    }),
  });
  logAudit(supabase, { method: 'POST', endpoint, entityType: 'suggestion', entityId: suggestion.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: suggestion, statusCode: 202 });
  return { status: 202, data: { ...suggestion, needs_approval: true, note } };
}

type TaskSuggestionInput = Parameters<typeof insertTaskSuggestion>[1];

/**
 * POST /api/v1/tasks (REST and the MCP create_task) with the building blocks
 * on top of createApiTask:
 * - dedupe_key: while an open task in the project holds the key, the create
 *   counts a repeat there (occurrence_note becomes a comment) and answers that
 *   task with deduplicated: true (200). The unique index settles two creates
 *   racing for the same key: the loser counts its repeat on the winner.
 * - An agent whose create policy is approval gets a suggestion (202), with
 *   suggestionMetadata (where the ask came from, such as an email's
 *   message_id) added to its metadata.
 * - An agent whose close policy is review cannot create a done task: it is
 *   created in review, with a comment saying why.
 */
export async function createTaskWithRules(ctx: CreateTaskContext, endpoint: string, suggestionMetadata: Record<string, unknown> = {}): Promise<RuledCreate> {
  const { supabase, teamMemberId, access } = ctx;
  // A personal assistant whose person turned off "Create tasks for me" makes none.
  await requireAssistantSwitch(supabase, teamMemberId, access, 'create_tasks');
  const { occurrence_note: occurrenceNote, ...body } = ctx.body as Record<string, unknown> & { occurrence_note?: string };
  const dedupeKey = typeof body.dedupe_key === 'string' ? body.dedupe_key : null;
  const member = await loadMemberRules(supabase, teamMemberId);
  // An agent paused on the project creates nothing there (looked up only when it is paused somewhere).
  if (currentPausedProjectIds().length > 0) {
    assertProjectWritable(await targetProject(supabase, body, access).catch(() => null));
  }

  let projectId: string | null = null;
  if (dedupeKey) {
    projectId = await targetProject(supabase, body, access);
    const repeat = await recordOccurrence(supabase, projectId, dedupeKey, occurrenceNote, teamMemberId);
    if (repeat) return { status: 200, data: repeat };
  }
  // The agents it goes to: their orchestrator, who can use them, ask first (202 with the approval; nothing is made).
  // A new task's approval it uses is claimed here and given back unless a task is made.
  const claimed: string[] = [];
  if (!ctx.agentsChecked) {
    const canAssignOthers = ctx.scopes.includes('tasks.manage_all') && accessAllows(access, 'tasks.manage_all', 'api');
    const requested = Array.isArray(body.assignee_ids) ? (body.assignee_ids as string[]) : [];
    if (canAssignOthers && requested.some((id) => id !== teamMemberId)) {
      projectId = projectId ?? await targetProject(supabase, body, access);
      const pending = await gateNewTaskAgents(supabase, access, teamMemberId, requested, projectId, String(body.title ?? ''),
        typeof body.parent_task_id === 'string' ? body.parent_task_id : null, claimed);
      if (pending) return { status: 202, data: { ...pending } };
    }
  }
  if (member.isAgent && member.rules.agent_create_policy === 'approval') {
    // A suggestion, not a task: the approval stays unused (approving the suggestion checks again).
    await releaseApprovals(supabase, claimed);
    return suggestInstead(ctx, member, body, endpoint, suggestionMetadata);
  }

  const close = applyClosePolicy(member, body.status as string | undefined);
  if (close.sentToReview) body.status = close.status;
  try {
    // The agents it goes to were checked above (or it goes only to its creator).
    const task = await createApiTask({ ...ctx, body, agentsChecked: true }, endpoint);
    if (!close.sentToReview) return { status: 201, data: { ...task } };
    await commentSentToReview(supabase, task.id, member);
    return { status: 201, data: { ...task, sent_to_review: true, note: sentToReviewNote(member) } };
  } catch (error) {
    if (dedupeKey && projectId && isOpenKeyConflict(error)) {
      const repeat = await recordOccurrence(supabase, projectId, dedupeKey, occurrenceNote, teamMemberId);
      await releaseApprovals(supabase, claimed);
      if (repeat) return { status: 200, data: repeat };
    }
    // No task was made: the approval it claimed goes back.
    await releaseApprovals(supabase, claimed);
    throw error;
  }
}
