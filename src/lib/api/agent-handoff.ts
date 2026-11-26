import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessContext } from '@/lib/access-control';
import { effectiveRunStatus, type AgentRunStatus } from '@/lib/agent-runs';
import { logAudit } from '@/lib/api/audit';
import { patchTask } from '@/lib/supabase/queries';
import { accessAllows, accessAllowsProject, delegateOf, resolveMemberAccess } from './access';
import { requireAgentsEnabled } from './agents';
import {
  canManageRuns, chainAccess, chainCycle, chainTooDeep, lineagePending, loadRun, missingLineageColumns, missingRunsTable, placeLive,
  principalMismatch, RUN_CHAIN_MAX_DEPTH, runAncestors, runDelegatedTo, runInReach, type RunsContext,
} from './agent-runs';
import { createTaskWithRules, type RuledCreate } from './create-task';
import { ApiError, forbidden, notFound } from './errors';
import { assertProjectWritable } from './request-gate';
import { loadParentTask, subtaskRuleError } from './subtasks';

/**
 * Agent-to-agent handoff, as building blocks rather than a router:
 *
 * - An orchestrator hands work to another agent with delegate_task: a new
 *   subtask of a task it may manage (mode subtask, the default), or a whole
 *   existing task, top-level or not (mode assign), through the same create
 *   and assign rules as create_task and update_task (so its rules, the
 *   receiver's access to the project and the person it acts for all
 *   apply). Naming the run it is in links the task to that run
 *   (pm.task_delegations, one row per task).
 * - The receiver starts its run with parent_run_id: the database derives
 *   the root and carries the person down (agent-runs.ts loadParentRun). A
 *   run can be the parent of runs on any task, so a chain goes as deep as
 *   RUN_CHAIN_MAX_DEPTH while subtasks stay one level.
 * - A chain for a person is worked with the receiver's access and the
 *   person's together (chainAccess), never switched to someone else, never
 *   looping back to an agent already above.
 * - get_run_tree reads the whole chain from any run in it.
 *
 * Which agent is the right receiver is the delegator's call: core never
 * routes work.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELEGATION_MODES = ['subtask', 'assign'] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

/** A table or column the database does not have yet (new code before its migration). */
const missingSchema = (error: { code?: string } | null) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || error.code === '42703' || error.code === 'PGRST204');

/** task_delegations rows, with mode and from_task_id once 20261125001600 is in (subtask before). */
async function readDelegations(db: SupabaseClient, column: 'task_id' | 'run_id', values: string[]): Promise<Row[]> {
  if (values.length === 0) return [];
  const full = await db.from('task_delegations').select('task_id, run_id, delegated_by, delegated_to, mode, from_task_id').in(column, values);
  if (!full.error) return (full.data ?? []) as Row[];
  if (full.error.code === '42P01' || full.error.code === 'PGRST205') return [];
  if (!missingSchema(full.error)) throw full.error;
  const older = await db.from('task_delegations').select('task_id, run_id, delegated_by, delegated_to').in(column, values);
  if (older.error) {
    if (missingSchema(older.error)) return [];
    throw older.error;
  }
  return ((older.data ?? []) as Row[]).map((row) => ({ ...row, mode: 'subtask', from_task_id: null }));
}

/** The run that delegated a task, for its brief; null when none did (or before the update). */
export async function delegationOf(db: SupabaseClient, taskId: string): Promise<{ run_id: string; agent_id: string | null; agent_name: string | null; mode: DelegationMode; from_task_id: string | null } | null> {
  const [row] = await readDelegations(db, 'task_id', [taskId]);
  if (!row) return null;
  const { data: run } = await db.from('agent_runs').select('agent_id').eq('id', row.run_id).maybeSingle();
  const agentId = ((run as Row | null)?.agent_id as string | undefined) ?? (row.delegated_by as string | null) ?? null;
  const { data: member } = agentId ? await db.from('team_members').select('name').eq('id', agentId).maybeSingle() : { data: null };
  return {
    run_id: row.run_id,
    agent_id: agentId,
    agent_name: ((member as Row | null)?.name as string | undefined) ?? null,
    mode: row.mode === 'assign' ? 'assign' : 'subtask',
    from_task_id: (row.from_task_id as string | null) ?? null,
  };
}

const SUBTASK_FIELDS = ['title', 'description', 'priority', 'due_date', 'acceptance_criteria', 'ai_readiness'] as const;

export const delegateTaskSchema = z.object({
  /** The receiver: an active agent team member. */
  agent_id: z.uuid('agent_id must be an agent team member id'),
  /** subtask (default): a new subtask of the task for the receiver. assign: the task itself, handed over as it is. */
  mode: z.enum(DELEGATION_MODES).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(50_000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  acceptance_criteria: z.array(z.string().min(1).max(2000)).max(50).optional(),
  /** Left out: ai_ready, the work an agent picks up. */
  ai_readiness: z.enum(['ai_ready', 'needs_spec', 'human_only']).nullable().optional(),
  /** The delegating run (the caller's own, or any with agents.manage): the task is linked to it. */
  run_id: z.uuid('run_id must be a run id').optional(),
  /** Mode assign: the caller comes off the task (and its claim) as the receiver goes on. */
  reassign: z.boolean().optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.mode ?? 'subtask') === 'subtask') {
    if (!input.title) ctx.addIssue({ code: 'custom', path: ['title'], message: 'title is required for a subtask' });
    if (input.reassign !== undefined) ctx.addIssue({ code: 'custom', path: ['reassign'], message: 'reassign goes with mode assign' });
    return;
  }
  for (const field of SUBTASK_FIELDS) {
    if (input[field] !== undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${field} describes a new subtask; mode assign hands the task over as it is (change it with update_task)` });
    }
  }
});
export type DelegateTaskInput = z.infer<typeof delegateTaskSchema>;

export interface DelegateContext {
  supabase: SupabaseClient;
  apiKeyId: string;
  teamMemberId: string;
  access: AccessContext;
  scopes: string[];
}

/** The receiver: an active agent, with the person it is bound to (a personal agent). */
async function loadReceiver(db: SupabaseClient, agentId: string): Promise<{ id: string; delegate_of: string | null }> {
  const { data, error } = await db.from('team_members').select('id, role, status').eq('id', agentId).maybeSingle();
  if (error) throw error;
  const target = data as Row | null;
  if (!target || target.role !== 'agent' || (target.status ?? 'active') !== 'active') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'agent_id must be an active agent team member', { reason: 'not_an_agent' });
  }
  return { id: target.id as string, delegate_of: await delegateOf(db, target.id as string) };
}

/** The receiver can open the project (a personal agent: only where its person can too). */
async function assertReceiverCanOpen(db: SupabaseClient, agentId: string, projectId: string): Promise<void> {
  const access = await resolveMemberAccess(db, agentId);
  if (!access || !(accessAllowsProject(access, projectId, 'api') || accessAllowsProject(access, projectId, 'app'))) {
    throw new ApiError(422, 'VALIDATION_ERROR', "That agent cannot open this task's project", {
      reason: 'receiver_no_project_access',
      hint: 'Add the agent to the project (its Agents tab), or hand the work to an agent that is on it.',
    });
  }
}

/** The task handed over in mode assign: live, in a live project the caller reaches. */
async function loadAssignedTask(db: SupabaseClient, taskId: string, access: AccessContext): Promise<Row> {
  if (!UUID.test(taskId)) throw notFound('Task');
  const { data, error } = await db
    .from('tasks')
    .select('*, task_assignees(member_id), project:projects!inner(id)')
    .eq('id', taskId)
    .is('deleted_at', null)
    .is('project.deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data || !accessAllowsProject(access, (data as Row).project_id, 'api')) throw notFound('Task');
  return data as Row;
}

/**
 * Delegates taskId to the named agent:
 * - mode subtask (default): a subtask of taskId assigned to the agent;
 *   answers what create_task answers for it (a task, or a suggestion when
 *   the caller's rules need approval);
 * - mode assign: taskId itself, the agent added to its assignees (the
 *   caller coming off with reassign); answers the task (200).
 * With run_id the task is linked to that run, and the chain's guards
 * apply: the person it is for is never switched and its access bounds the
 * hand-off, at most RUN_CHAIN_MAX_DEPTH deep, never back to an agent above.
 * A personal agent hands work on only while acting for its person, and only
 * to company agents. Answers task_id, delegated_to, run_id and mode.
 */
export async function delegateTask(ctx: DelegateContext, taskId: string, input: DelegateTaskInput): Promise<RuledCreate> {
  requireAgentsEnabled(ctx.access);
  const mode: DelegationMode = input.mode ?? 'subtask';
  const target = await loadReceiver(ctx.supabase, input.agent_id);

  // A personal agent works only for its person, and hands their work only to company agents.
  const callerPerson = ctx.access.role === 'agent' ? await delegateOf(ctx.supabase, ctx.teamMemberId) : null;
  if (callerPerson && ctx.access.principal_id !== callerPerson) {
    throw forbidden('A personal agent hands work on only while acting for its person', {
      reason: 'personal_agent_not_acting',
      hint: 'Delegate from a run made for your person, with your own key (it always acts for them).',
    });
  }
  if (callerPerson && target.delegate_of) {
    throw forbidden('A personal agent hands work only to company agents', {
      reason: 'receiver_is_personal_agent',
      hint: 'Pick a company agent (list_agents with personal: "exclude").',
    });
  }

  let run: Row | null = null;
  let access = ctx.access;
  if (input.run_id) {
    const runs: RunsContext = { db: ctx.supabase, access: ctx.access, memberId: ctx.teamMemberId, scopes: ctx.scopes };
    run = await loadRun(runs, input.run_id);
    // The chain's person bounds everything this hand-off touches; acting for someone else is refused.
    access = await chainAccess(ctx.supabase, ctx.access, (run.principal_id as string | null) ?? null);
    const above = await runAncestors(ctx.supabase, run);
    if (above.length > RUN_CHAIN_MAX_DEPTH) throw chainTooDeep();
    if (above.some((r) => r.agent_id === target.id)) throw chainCycle(target.id);
    // Before the update there is nowhere to link it: refuse before anything is made.
    const probe = await ctx.supabase.from('task_delegations').select('task_id').limit(1);
    if (probe.error) {
      if (probe.error.code === '42P01' || probe.error.code === 'PGRST205') throw lineagePending();
      throw probe.error;
    }
  }
  // A personal agent receives only its own person's work.
  if (target.delegate_of && target.delegate_of !== (access.principal_id ?? null)) throw principalMismatch();
  const acting: DelegateContext = { ...ctx, access };

  if (mode === 'assign') return assignTask(acting, taskId, input, target.id, run);

  const parent = await loadParentTask(ctx.supabase, taskId, access);
  await assertReceiverCanOpen(ctx.supabase, target.id, parent.project_id);
  const { agent_id: agentId, run_id: _run, mode: _mode, reassign: _reassign, ...fields } = input;
  void _run; void _mode; void _reassign;
  const body = {
    ...fields,
    ai_readiness: input.ai_readiness === undefined ? 'ai_ready' : input.ai_readiness,
    parent_task_id: taskId,
    assignee_ids: [agentId],
  };
  const result = await createTaskWithRules({ ...acting, body }, `/api/v1/tasks/${taskId}/delegate`, run ? { delegated_from_run_id: run.id } : {});
  const newTaskId = result.status === 202 ? null : (result.data.id as string);
  if (newTaskId && run) {
    await recordDelegation(ctx.supabase, { task_id: newTaskId, run_id: run.id, delegated_by: ctx.teamMemberId, delegated_to: agentId, mode, from_task_id: taskId });
  }
  return {
    status: result.status,
    data: { ...result.data, task_id: newTaskId, delegated_to: agentId, run_id: run?.id ?? null, mode },
  };
}

/** Mode assign: the task itself goes to the receiver, through update_task's assignment rules. */
async function assignTask(ctx: DelegateContext, taskId: string, input: DelegateTaskInput, agentId: string, run: Row | null): Promise<RuledCreate> {
  const task = await loadAssignedTask(ctx.supabase, taskId, ctx.access);
  const canManageAll = ctx.scopes.includes('tasks.manage_all') && accessAllows(ctx.access, 'tasks.manage_all', 'api');
  if (!canManageAll) {
    throw forbidden('Handing a task to another agent changes who it is assigned to, which requires the tasks.manage_all API scope', { reason: 'manage_all_required' });
  }
  if (task.status === 'done') {
    throw new ApiError(409, 'CONFLICT', 'This task is done: there is nothing left to hand over.', { reason: 'task_done' });
  }
  assertProjectWritable(task.project_id as string);
  await assertReceiverCanOpen(ctx.supabase, agentId, task.project_id as string);

  const current = ((task.task_assignees ?? []) as { member_id: string }[]).map((a) => a.member_id);
  const next = [...new Set([...current.filter((id) => !(input.reassign && id === ctx.teamMemberId)), agentId])];
  const changed = next.length !== current.length || next.some((id) => !current.includes(id));
  let saved: Row = task;
  if (changed) {
    try {
      saved = (await patchTask(ctx.supabase, taskId, {}, next)) as Row;
    } catch (error) {
      throw subtaskRuleError(error);
    }
  }
  const { task_assignees: _assignees, project: _project, ...plain } = saved;
  void _assignees; void _project;
  if (run) {
    const fromTask = (run.task_id as string | null) ?? null;
    await recordDelegation(ctx.supabase, {
      task_id: taskId, run_id: run.id, delegated_by: ctx.teamMemberId, delegated_to: agentId, mode: 'assign',
      from_task_id: fromTask && fromTask !== taskId ? fromTask : null,
    });
  }
  const data = { ...plain, assignee_ids: next, task_id: taskId, delegated_to: agentId, run_id: run?.id ?? null, mode: 'assign' as const };
  logAudit(ctx.supabase, {
    method: 'POST', endpoint: `/api/v1/tasks/${taskId}/delegate`, entityType: 'task', entityId: taskId, apiKeyId: ctx.apiKeyId,
    teamMemberId: ctx.teamMemberId, requestBody: input, beforeSnapshot: task, afterSnapshot: data, statusCode: 200,
  });
  return { status: 200, data };
}

/** The task's delegation row (one per task: a later hand-off replaces it). */
async function recordDelegation(db: SupabaseClient, row: { task_id: string; run_id: string; delegated_by: string; delegated_to: string; mode: DelegationMode; from_task_id: string | null }) {
  const { error } = await db.from('task_delegations').upsert({ ...row, created_at: new Date().toISOString() }, { onConflict: 'task_id' });
  if (!error) return;
  if (!missingSchema(error)) throw error;
  // Before 20261125001600: the link without how or where from.
  const { mode: _mode, from_task_id: _from, ...older } = row;
  void _mode; void _from;
  const retry = await db.from('task_delegations').upsert(older, { onConflict: 'task_id' });
  if (retry.error) throw retry.error;
}

// ── The run tree ─────────────────────────────────────────────────────────

export const RUN_TREE_MAX = 500;

export interface RunTreeDelegation {
  task_id: string;
  delegated_to: string | null;
  /** subtask: a subtask made for the receiver; assign: the task itself. */
  mode: DelegationMode;
}

export interface RunTreeNode {
  id: string;
  parent_run_id: string | null;
  depth: number;
  agent_id: string;
  agent_name: string | null;
  task_id: string | null;
  status: AgentRunStatus;
  title: string | null;
  started_at: string;
  finished_at: string | null;
  /** The person this run worked for; null for an agent's own work. */
  principal_id: string | null;
  /** The reader's own run, or any with agents.manage: summary, tokens, cost and trace link come with it. */
  visible: boolean;
  summary: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  external_url: string | null;
  /** Tasks this run handed to other agents (subtasks, or whole tasks). */
  delegated: RunTreeDelegation[];
}

export interface RunTree {
  root_run_id: string;
  run_id: string;
  /** The person the whole chain works for (its root's); null for agents' own work. */
  principal_id: string | null;
  /** How many levels the chain has: the deepest run's depth plus one. */
  levels: number;
  /** The deepest a run may sit below the root. */
  max_depth: number;
  runs: RunTreeNode[];
  truncated: boolean;
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * The chain a run belongs to, from its root, in start order with each run's
 * depth, across every task its runs worked on. Readable by anyone who sees
 * one of its runs (their own, every run with agents.manage, or a run that
 * delegated to them). Every run shows who ran it, on which task, its status
 * and title; a run the reader may not read in full (another agent's) leaves
 * out its summary, tokens, cost and trace link. A run on a task or project
 * in Trash, or out of reach while acting for someone, shows only its place
 * in the chain.
 */
export async function runTree(ctx: RunsContext, runId: string): Promise<RunTree> {
  requireAgentsEnabled(ctx.access);
  if (!UUID.test(runId)) throw notFound('Run');
  const { data: start, error } = await ctx.db.from('agent_runs').select('*').eq('id', runId).maybeSingle();
  if (missingRunsTable(error)) throw notFound('Run');
  if (error) throw error;
  if (!start) throw notFound('Run');
  const rootId = ((start as Row).root_run_id as string | null) ?? (start as Row).id as string;
  const { data: rowsData, error: rowsError } = await ctx.db.from('agent_runs').select('*')
    .or(`id.eq.${rootId},root_run_id.eq.${rootId}`)
    .order('started_at').order('id').limit(RUN_TREE_MAX + 1);
  if (missingLineageColumns(rowsError)) {
    // Before the update every run is its own tree.
    const own = await loadRun(ctx, runId);
    return {
      root_run_id: own.id, run_id: own.id, principal_id: (own.principal_id as string | null) ?? null, levels: 1, max_depth: RUN_CHAIN_MAX_DEPTH,
      runs: [await nodeOf(ctx, own, 0, true, [])], truncated: false,
    };
  }
  if (rowsError) throw rowsError;
  const rows = ((rowsData ?? []) as Row[]).slice(0, RUN_TREE_MAX);
  const manage = canManageRuns(ctx);
  let reads = manage || rows.some((row) => row.agent_id === ctx.memberId && runInReach(ctx, row));
  for (const row of rows) {
    if (reads) break;
    if (runInReach(ctx, row) && await runDelegatedTo(ctx.db, row.id, ctx.memberId)) reads = true;
  }
  if (!reads) throw notFound('Run');

  const delegations = await readDelegations(ctx.db, 'run_id', rows.map((row) => row.id as string));
  const byRun = new Map<string, RunTreeDelegation[]>();
  for (const d of delegations) {
    const list = byRun.get(d.run_id) ?? [];
    list.push({ task_id: d.task_id, delegated_to: d.delegated_to ?? null, mode: d.mode === 'assign' ? 'assign' : 'subtask' });
    byRun.set(d.run_id, list);
  }
  const parentOf = new Map(rows.map((row) => [row.id as string, (row.parent_run_id as string | null) ?? null]));
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let at = parentOf.get(id); at && depth < RUN_TREE_MAX; at = parentOf.get(at)) depth++;
    return depth;
  };
  const nodes: RunTreeNode[] = [];
  for (const row of rows) {
    const live = runInReach(ctx, row) && await placeLive(ctx.db, row);
    nodes.push(await nodeOf(ctx, row, depthOf(row.id), live && (manage || row.agent_id === ctx.memberId), live ? byRun.get(row.id) ?? [] : [], live));
  }
  const root = rows.find((row) => row.id === rootId);
  return {
    root_run_id: rootId,
    run_id: (start as Row).id,
    principal_id: ((root ?? start) as Row).principal_id ?? null,
    levels: nodes.reduce((deepest, n) => Math.max(deepest, n.depth + 1), 1),
    max_depth: RUN_CHAIN_MAX_DEPTH,
    runs: nodes,
    truncated: ((rowsData ?? []) as Row[]).length > RUN_TREE_MAX,
  };
}

async function nodeOf(ctx: RunsContext, row: Row, depth: number, full: boolean, delegated: RunTreeNode['delegated'], live = true): Promise<RunTreeNode> {
  const { data } = await ctx.db.from('team_members').select('name').eq('id', row.agent_id).maybeSingle();
  return {
    id: row.id,
    parent_run_id: row.parent_run_id ?? null,
    depth,
    agent_id: row.agent_id,
    agent_name: ((data as Row | null)?.name as string | undefined) ?? null,
    task_id: live ? row.task_id ?? null : null,
    status: effectiveRunStatus(row as { status: string; updated_at: string }),
    title: live ? row.title ?? null : null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    principal_id: row.principal_id ?? null,
    visible: full,
    summary: full ? row.summary ?? null : null,
    tokens_in: full ? num(row.tokens_in) : null,
    tokens_out: full ? num(row.tokens_out) : null,
    cost_usd: full ? num(row.cost_usd) : null,
    external_url: full ? row.external_url ?? null : null,
    delegated,
  };
}
