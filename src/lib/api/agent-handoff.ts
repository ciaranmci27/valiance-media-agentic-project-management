import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessContext } from '@/lib/access-control';
import { effectiveRunStatus, type AgentRunStatus } from '@/lib/agent-runs';
import { requireAgentsEnabled } from './agents';
import {
  canManageRuns, lineagePending, loadRun, missingLineageColumns, missingRunsTable, placeLive, runDelegatedTo, runInReach, type RunsContext,
} from './agent-runs';
import { createTaskWithRules, type RuledCreate } from './create-task';
import { ApiError, notFound } from './errors';

/**
 * Agent-to-agent handoff, as building blocks rather than a router:
 *
 * - An orchestrator hands work to a specialist with delegate_task: a
 *   subtask of a task it may manage, assigned to that agent, through the
 *   same create and assign as create_task (so its rules, the specialist's
 *   access to the project and the person it acts for all apply). Naming the
 *   run it is in links the subtask to that run (pm.task_delegations).
 * - The specialist starts its run with parent_run_id: the database derives
 *   the root and carries the person down (agent-runs.ts loadParentRun).
 * - get_run_tree reads the whole chain from any run in it.
 *
 * Which agent is the right specialist is the orchestrator's call: core never
 * routes work.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run that delegated a task, for its brief; null when none did (or before the update). */
export async function delegationOf(db: SupabaseClient, taskId: string): Promise<{ run_id: string; agent_id: string | null; agent_name: string | null } | null> {
  const { data, error } = await db.from('task_delegations').select('run_id, delegated_by').eq('task_id', taskId).maybeSingle();
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return null;
    throw error;
  }
  if (!data) return null;
  const row = data as Row;
  const { data: run } = await db.from('agent_runs').select('agent_id').eq('id', row.run_id).maybeSingle();
  const agentId = ((run as Row | null)?.agent_id as string | undefined) ?? (row.delegated_by as string | null) ?? null;
  const { data: member } = agentId ? await db.from('team_members').select('name').eq('id', agentId).maybeSingle() : { data: null };
  return { run_id: row.run_id, agent_id: agentId, agent_name: ((member as Row | null)?.name as string | undefined) ?? null };
}

export const delegateTaskSchema = z.object({
  /** The specialist: an active agent team member. */
  agent_id: z.uuid('agent_id must be an agent team member id'),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
  acceptance_criteria: z.array(z.string().min(1).max(2000)).max(50).optional(),
  /** Left out: ai_ready, the work an agent picks up. */
  ai_readiness: z.enum(['ai_ready', 'needs_spec', 'human_only']).nullable().optional(),
  /** The delegating run (the caller's own, or any with agents.manage): the subtask is linked to it. */
  run_id: z.uuid('run_id must be a run id').optional(),
}).strict();
export type DelegateTaskInput = z.infer<typeof delegateTaskSchema>;

export interface DelegateContext {
  supabase: SupabaseClient;
  apiKeyId: string;
  teamMemberId: string;
  access: AccessContext;
  scopes: string[];
}

/**
 * Delegates: a subtask of parentTaskId assigned to the named agent, linked
 * to run_id when sent. Answers what create_task answers for it (a task, or
 * a suggestion when the caller's rules need approval) plus task_id,
 * delegated_to and run_id.
 */
export async function delegateTask(ctx: DelegateContext, parentTaskId: string, input: DelegateTaskInput): Promise<RuledCreate> {
  requireAgentsEnabled(ctx.access);
  const { data: agent, error: agentError } = await ctx.supabase.from('team_members').select('id, role, status').eq('id', input.agent_id).maybeSingle();
  if (agentError) throw agentError;
  const target = agent as Row | null;
  if (!target || target.role !== 'agent' || (target.status ?? 'active') !== 'active') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'agent_id must be an active agent team member', { reason: 'not_an_agent' });
  }
  let runId: string | null = null;
  if (input.run_id) {
    const runs: RunsContext = { db: ctx.supabase, access: ctx.access, memberId: ctx.teamMemberId, scopes: ctx.scopes };
    runId = (await loadRun(runs, input.run_id)).id as string;
    // Before the update there is nowhere to link it: refuse before anything is made.
    const probe = await ctx.supabase.from('task_delegations').select('task_id').limit(1);
    if (probe.error) {
      if (probe.error.code === '42P01' || probe.error.code === 'PGRST205') throw lineagePending();
      throw probe.error;
    }
  }
  const { agent_id: agentId, run_id: _run, ...fields } = input;
  void _run;
  const body = {
    ...fields,
    ai_readiness: input.ai_readiness === undefined ? 'ai_ready' : input.ai_readiness,
    parent_task_id: parentTaskId,
    assignee_ids: [agentId],
  };
  const result = await createTaskWithRules({ ...ctx, body }, `/api/v1/tasks/${parentTaskId}/delegate`, runId ? { delegated_from_run_id: runId } : {});
  const taskId = result.status === 202 ? null : (result.data.id as string);
  if (taskId && runId) {
    const { error } = await ctx.supabase.from('task_delegations').upsert({
      task_id: taskId, run_id: runId, delegated_by: ctx.teamMemberId, delegated_to: agentId,
    }, { onConflict: 'task_id' });
    if (error) throw error;
  }
  return {
    status: result.status,
    data: { ...result.data, task_id: taskId, delegated_to: agentId, run_id: runId },
  };
}

// ── The run tree ─────────────────────────────────────────────────────────

export const RUN_TREE_MAX = 500;

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
  /** The reader's own run, or any with agents.manage: summary, tokens, cost and trace link come with it. */
  visible: boolean;
  summary: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  external_url: string | null;
  /** Subtasks this run handed to other agents. */
  delegated: { task_id: string; delegated_to: string | null }[];
}

export interface RunTree {
  root_run_id: string;
  run_id: string;
  runs: RunTreeNode[];
  truncated: boolean;
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * The chain a run belongs to, from its root, in start order with each run's
 * depth. Readable by anyone who sees one of its runs (their own, every run
 * with agents.manage, or a run that delegated to them). Every run shows who
 * ran it, on which task, its status and title; a run the reader may not
 * read in full (another agent's) leaves out its summary, tokens, cost and
 * trace link. A run on a task or project in Trash, or out of reach while
 * acting for someone, shows only its place in the chain.
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
    return { root_run_id: own.id, run_id: own.id, runs: [await nodeOf(ctx, own, 0, true, [])], truncated: false };
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

  const ids = rows.map((row) => row.id as string);
  const { data: delegations, error: delegationsError } = await ctx.db.from('task_delegations').select('task_id, run_id, delegated_to').in('run_id', ids);
  if (delegationsError && delegationsError.code !== '42P01' && delegationsError.code !== 'PGRST205') throw delegationsError;
  const byRun = new Map<string, { task_id: string; delegated_to: string | null }[]>();
  for (const d of (delegations ?? []) as Row[]) {
    const list = byRun.get(d.run_id) ?? [];
    list.push({ task_id: d.task_id, delegated_to: d.delegated_to ?? null });
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
  return { root_run_id: rootId, run_id: (start as Row).id, runs: nodes, truncated: ((rowsData ?? []) as Row[]).length > RUN_TREE_MAX };
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
    visible: full,
    summary: full ? row.summary ?? null : null,
    tokens_in: full ? num(row.tokens_in) : null,
    tokens_out: full ? num(row.tokens_out) : null,
    cost_usd: full ? num(row.cost_usd) : null,
    external_url: full ? row.external_url ?? null : null,
    delegated,
  };
}
