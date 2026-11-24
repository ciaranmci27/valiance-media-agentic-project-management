import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext, PermissionKey } from '@/lib/access-control';
import {
  AGENT_RUN_LIMITS,
  AGENT_RUN_STATUSES,
  effectiveRunStatus,
  type AgentRunNote,
  type AgentRunStatus,
  type AgentRunSummary,
  type AgentRunTurns,
  type AgentRunView,
  type FinishAgentRunInput,
  type StartAgentRunInput,
  type TaskLatestRun,
  type UpdateAgentRunInput,
  AGENT_RUN_STALE_AFTER_SECONDS,
} from '@/lib/agent-runs';
import { postgrestList, trashedProjectIds } from '@/lib/supabase/trash';
import { accessAllows, accessAllowsProject, apiKeyAllows } from './access';
import { requireAgentsEnabled } from './agents';
import { ApiError, badRequest, forbidden, notFound } from './errors';

/**
 * Agent runs for the API (v1, MCP): one run of an agent, started, updated
 * and finished by its own key. Routes run on the service role, so the
 * visibility the database gives a signed-in member is enforced here, the same
 * as for agent_activities: a key reads and writes its own member's runs, and
 * a key with agents.manage (on key and member) every agent's. Runs on a task
 * or project in Trash are out of reach with it.
 *
 * Reads go through pm.agent_run_feed: stored runs plus the turn.completed
 * rows that name no run, so an agent that never starts a run still shows
 * its work. Turns are never copied (see src/lib/agent-runs.ts).
 */

/** Any agent key that logs its activity or reads tasks; agents.manage for every agent's runs. */
export const RUN_PERMISSIONS: PermissionKey[] = ['agent_activity.write', 'tasks.read', 'agents.manage'];

export interface RunsContext {
  db: SupabaseClient;
  access: AccessContext;
  memberId: string;
  scopes: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FEED_COLUMNS = 'id, source, agent_id, task_id, project_id, status, outcome, title, summary, model, trigger, started_at, finished_at, duration_ms, tokens_in, tokens_out, cost_usd, external_id, external_url, sort_at, updated_at';

const invalid = (message: string, details?: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

/**
 * A write the database refused for one of its checks (23514), as a clean 422
 * naming the check. The API's own limits are tighter, so this is a backstop;
 * any other error passes through.
 */
export function runWriteError(error: { code?: string; message?: string }): unknown {
  if (error?.code !== '23514') return error;
  const constraint = /constraint "([^"]+)"/.exec(error.message ?? '')?.[1] ?? null;
  return invalid('This run breaks one of its limits; check the fields you sent.', { reason: 'run_check_failed', constraint });
}

/** A database that does not have the runs table or view yet (new code before its migration). */
export const missingRunsTable = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /agent_run(s|_feed).*(does not exist|schema cache)/i.test(error.message ?? ''));

/** The key and its member both hold agents.manage: every agent's runs. */
export const canManageRuns = (ctx: RunsContext) => apiKeyAllows(ctx.access, ctx.scopes, 'agents.manage');

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

async function memberNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await db.from('team_members').select('id, name').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
}

/** The turns attached to each run (turn.completed with metadata.run_id). */
async function attachedTurns(db: SupabaseClient, runIds: string[]): Promise<Map<string, AgentRunTurns>> {
  const out = new Map<string, AgentRunTurns>();
  if (runIds.length === 0) return out;
  const { data, error } = await db
    .from('agent_activities')
    .select('metadata')
    .eq('activity_type', 'turn.completed')
    .in('metadata->>run_id', runIds);
  if (error) throw error;
  for (const { metadata: m } of (data ?? []) as { metadata: Row }[]) {
    const id = String(m?.run_id ?? '');
    const turns = out.get(id) ?? { count: 0, duration_ms: 0, tokens_in: null, tokens_out: null };
    turns.count += 1;
    turns.duration_ms += Number.isFinite(Number(m.duration_ms)) ? Math.max(0, Number(m.duration_ms)) : 0;
    // Only a turn's own tokens add up; session totals would count a session again per turn.
    if (m.tokens_scope === 'turn' && m.tokens && typeof m.tokens === 'object') {
      if (Number.isFinite(Number(m.tokens.input))) turns.tokens_in = (turns.tokens_in ?? 0) + Number(m.tokens.input);
      if (Number.isFinite(Number(m.tokens.output))) turns.tokens_out = (turns.tokens_out ?? 0) + Number(m.tokens.output);
    }
    out.set(id, turns);
  }
  return out;
}

async function present(db: SupabaseClient, rows: Row[]): Promise<AgentRunSummary[]> {
  const [names, turns] = await Promise.all([
    memberNames(db, rows.map((r) => r.agent_id)),
    attachedTurns(db, rows.filter((r) => r.source === 'run').map((r) => r.id)),
  ]);
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    agent_id: row.agent_id,
    agent_name: names.get(row.agent_id) ?? null,
    task_id: row.task_id ?? null,
    project_id: row.project_id ?? null,
    // The view already reads a stale run as timed_out; this keeps one rule for rows read from the table.
    status: row.source === 'run' ? effectiveRunStatus(row as { status: string; updated_at: string }) : row.status,
    outcome: row.outcome ?? null,
    title: row.title ?? null,
    summary: row.summary ?? null,
    model: row.model ?? null,
    trigger: row.trigger ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    duration_ms: num(row.duration_ms),
    tokens_in: num(row.tokens_in),
    tokens_out: num(row.tokens_out),
    cost_usd: num(row.cost_usd),
    external_id: row.external_id ?? null,
    external_url: row.external_url ?? null,
    updated_at: row.updated_at,
    ...(row.source === 'run' ? { turns: turns.get(row.id) ?? { count: 0, duration_ms: 0, tokens_in: null, tokens_out: null } } : {}),
    // Only a run made for someone carries it, so other runs read as they always have.
    ...(row.principal_id ? { principal_id: row.principal_id as string } : {}),
  }));
}

function durationOf(row: Row): number | null {
  return row.finished_at ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.started_at)) : null;
}

/** Stored runs as summaries, in one batch (the agent list's current runs). */
export function presentStoredRuns(db: SupabaseClient, rows: Row[]): Promise<AgentRunSummary[]> {
  return present(db, rows.map((row) => ({ ...row, source: 'run', outcome: null, duration_ms: durationOf(row) })));
}

/** A stored run in full. */
async function presentRun(db: SupabaseClient, row: Row): Promise<AgentRunView> {
  const [summary] = await present(db, [{ ...row, source: 'run', outcome: null, duration_ms: durationOf(row) }]);
  return {
    ...summary,
    plan: Array.isArray(row.plan) ? row.plan : [],
    notes: Array.isArray(row.notes) ? row.notes : [],
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  };
}

/** Tasks in Trash that still have runs: theirs go out of reach with them. */
async function trashedRunTasks(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from('agent_runs')
    .select('task_id, task:tasks!inner(id)')
    .not('task.deleted_at', 'is', null);
  if (error) throw error;
  return [...new Set((data ?? []).map((row: { task_id: string }) => row.task_id))];
}

/** Whether a stored run's task and project are out of Trash. */
async function placeLive(db: SupabaseClient, row: Row): Promise<boolean> {
  if (row.task_id) {
    const { data, error } = await db.from('tasks').select('id').eq('id', row.task_id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) return false;
  }
  if (row.project_id) {
    const { data, error } = await db.from('projects').select('id').eq('id', row.project_id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) return false;
  }
  return true;
}

/** A stored run this key may see; hidden, in Trash and missing read the same. */
async function loadRun(ctx: RunsContext, id: string): Promise<Row> {
  if (!UUID.test(id)) throw notFound('Run');
  const { data, error } = await ctx.db.from('agent_runs').select('*').eq('id', id).maybeSingle();
  if (missingRunsTable(error)) throw notFound('Run');
  if (error) throw error;
  if (!data || (data.agent_id !== ctx.memberId && !canManageRuns(ctx)) || !runInReach(ctx, data) || !(await placeLive(ctx.db, data))) throw notFound('Run');
  return data as Row;
}

/**
 * Acting for a person (X-Act-For), the agent's own runs are no reach of
 * theirs: a run counts only on a project both reach, or, on nothing, when
 * the agent ran it for this same person. Without a principal, every run the
 * key could read before.
 */
function runInReach(ctx: RunsContext, row: Row): boolean {
  const principal = ctx.access.principal_id;
  if (!principal) return true;
  if (row.project_id) return accessAllowsProject(ctx.access, row.project_id as string, 'api');
  return row.principal_id === principal;
}

/** The filter that keeps a request acting for someone to runInReach's stored runs; null without a principal. */
function runsReachFilter(ctx: RunsContext): string | null {
  const principal = ctx.access.principal_id;
  if (!principal) return null;
  const readAll = accessAllows(ctx.access, 'projects.read_all', 'api');
  const projects = accessAllows(ctx.access, 'projects.read', 'api') ? ctx.access.project_ids : [];
  const inReach = readAll ? 'project_id.not.is.null' : projects.length ? `project_id.in.(${projects.join(',')})` : null;
  return [...(inReach ? [inReach] : []), `and(project_id.is.null,principal_id.eq.${principal})`].join(',');
}

/** Where a run hangs: a live task (its project comes with it), a live project, or nothing. */
async function resolvePlace(ctx: RunsContext, input: { task_id?: string | null; project_id?: string | null }) {
  if (input.task_id) {
    const { data: task, error } = await ctx.db
      .from('tasks')
      .select('id, project_id, project:projects!inner(id)')
      .eq('id', input.task_id)
      .is('deleted_at', null)
      .is('project.deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!task || !accessAllowsProject(ctx.access, task.project_id, 'api')) throw notFound('Task');
    if (input.project_id && input.project_id !== task.project_id) {
      throw badRequest("project_id does not match the task's project; send task_id alone");
    }
    return { task_id: task.id as string, project_id: task.project_id as string };
  }
  if (input.project_id) {
    if (!accessAllowsProject(ctx.access, input.project_id, 'api')) throw notFound('Project');
    const { data, error } = await ctx.db.from('projects').select('id').eq('id', input.project_id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) throw notFound('Project');
    return { task_id: null, project_id: input.project_id };
  }
  return { task_id: null, project_id: null };
}

/** Whose run a start records: the key's own member, or (agents.manage) another agent. */
async function resolveAgent(ctx: RunsContext, agentId: string | undefined): Promise<string> {
  if (!agentId || agentId === ctx.memberId) {
    if (ctx.access.role !== 'agent') {
      throw forbidden('Only agent team members record runs', {
        reason: 'agents_only',
        hint: 'Use an agent\'s own key, or name agent_id with a key that holds agents.manage.',
      });
    }
    return ctx.memberId;
  }
  if (!canManageRuns(ctx)) {
    throw forbidden('An agent records only its own runs', {
      reason: 'own_runs_only',
      hint: 'Leave agent_id out: the key decides whose run it is. Recording another agent\'s run needs agents.manage on key and member.',
    });
  }
  const { data, error } = await ctx.db.from('team_members').select('id, role').eq('id', agentId).eq('status', 'active').maybeSingle();
  if (error) throw error;
  if (!data || data.role !== 'agent') throw invalid('agent_id must be an active agent team member', { reason: 'agent_id_not_agent' });
  return agentId;
}

/** The run fields a start, update or finish writes, from its input. */
type RunFieldsInput = Pick<StartAgentRunInput, 'title' | 'summary' | 'plan' | 'note' | 'tokens_in' | 'tokens_out' | 'cost_usd' | 'model' | 'provider' | 'external_url' | 'metadata'>;

function fieldsFrom(input: RunFieldsInput, notes: AgentRunNote[] | null): Row {
  const out: Row = {};
  // provider is written only when sent, so a run without one saves as before.
  for (const key of ['title', 'summary', 'plan', 'tokens_in', 'tokens_out', 'cost_usd', 'model', 'provider', 'external_url', 'metadata'] as const) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (input.note !== undefined) {
    // The newest notes are kept; the oldest go first.
    out.notes = [...(notes ?? []), { at: new Date().toISOString(), text: input.note }].slice(-AGENT_RUN_LIMITS.notes);
  }
  return out;
}

function notBefore(start: string, value: string, field: string) {
  if (Date.parse(value) < Date.parse(start)) throw invalid(`${field} cannot be before the run started`, { reason: 'before_start', started_at: start });
}

const finished = (status: string) => status !== 'running';

/**
 * Starts a run, or (the same external_id for this agent again) answers with
 * that run, updated with what this call sends: a harness that retries, or
 * starts every run with its own id, never makes two. created says which.
 */
export async function startRun(ctx: RunsContext, input: StartAgentRunInput): Promise<{ run: AgentRunView; created: boolean }> {
  requireAgentsEnabled(ctx.access);
  const agentId = await resolveAgent(ctx, input.agent_id);
  const place = await resolvePlace(ctx, input);
  if (input.started_at && Date.parse(input.started_at) > Date.now() + 60_000) {
    throw invalid('started_at cannot be in the future', { reason: 'starts_in_future' });
  }

  if (input.external_id) {
    const existing = await runByExternalId(ctx.db, agentId, input.external_id);
    if (existing) return { run: await updateExisting(ctx, existing, input, place), created: false };
  }

  const row: Row = {
    ...fieldsFrom(input, null),
    agent_id: agentId,
    task_id: place.task_id,
    project_id: place.project_id,
    trigger: input.trigger ?? null,
    external_id: input.external_id ?? null,
    ...(input.started_at ? { started_at: input.started_at } : {}),
  };
  const { data, error } = await ctx.db.from('agent_runs').insert(row).select('*').single();
  if (error) {
    // Two starts with one external_id at once: the second answers with the first.
    if (error.code === '23505' && input.external_id) {
      const existing = await runByExternalId(ctx.db, agentId, input.external_id);
      if (existing) return { run: await updateExisting(ctx, existing, input, place), created: false };
    }
    throw runWriteError(error);
  }
  return { run: await presentRun(ctx.db, data as Row), created: true };
}

async function runByExternalId(db: SupabaseClient, agentId: string, externalId: string): Promise<Row | null> {
  const { data, error } = await db.from('agent_runs').select('*').eq('agent_id', agentId).eq('external_id', externalId).maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

/** A repeated start: what it sends lands on the run it names; its status stays. */
async function updateExisting(ctx: RunsContext, existing: Row, input: StartAgentRunInput, place: { task_id: string | null; project_id: string | null }): Promise<AgentRunView> {
  if (!(await placeLive(ctx.db, existing))) throw notFound('Run');
  const changes: Row = { ...fieldsFrom(input, existing.notes) };
  if (input.task_id !== undefined || input.project_id !== undefined) Object.assign(changes, place);
  if (input.trigger !== undefined) changes.trigger = input.trigger;
  if (Object.keys(changes).length === 0) return presentRun(ctx.db, existing);
  const { data, error } = await ctx.db.from('agent_runs').update(changes).eq('id', existing.id).select('*').single();
  if (error) throw runWriteError(error);
  return presentRun(ctx.db, data as Row);
}

/**
 * Changes a run: plan, a progress note, tokens and cost so far (totals, not
 * increments, so a retry is safe), and the rest. A finished status finishes
 * it. A finished run keeps its status (409 run_finished for another one) but
 * still takes late details: a trace link, a summary, its final tokens.
 * Only the run's agent, or a key with agents.manage.
 */
export async function updateRun(ctx: RunsContext, id: string, input: UpdateAgentRunInput & { finished_at?: string }): Promise<AgentRunView> {
  requireAgentsEnabled(ctx.access);
  const row = await loadRun(ctx, id);
  const changes = fieldsFrom(input, row.notes);
  if (input.task_id !== undefined) Object.assign(changes, await resolvePlace(ctx, { task_id: input.task_id }));
  if (input.status !== undefined && input.status !== row.status) {
    if (finished(row.status)) {
      throw new ApiError(409, 'CONFLICT', `This run already finished (${row.status}).`, { reason: 'run_finished', status: row.status });
    }
    if (!(AGENT_RUN_STATUSES as readonly string[]).includes(input.status)) throw badRequest('Unknown status');
    changes.status = input.status;
    if (finished(input.status)) {
      const at = input.finished_at ?? new Date().toISOString();
      if (input.finished_at) notBefore(row.started_at, at, 'finished_at');
      changes.finished_at = Date.parse(at) < Date.parse(row.started_at) ? row.started_at : at;
    }
  }
  if (Object.keys(changes).length === 0) return presentRun(ctx.db, row);
  const { data, error } = await ctx.db.from('agent_runs').update(changes).eq('id', row.id).select('*').single();
  if (error) throw runWriteError(error);
  // Another write finished it between our read and this one: the database
  // kept the first finish (handle_agent_run_before_write), so this one lost.
  if (changes.status !== undefined && data.status !== changes.status) {
    throw new ApiError(409, 'CONFLICT', `This run already finished (${data.status}).`, { reason: 'run_finished', status: data.status });
  }
  return presentRun(ctx.db, data as Row);
}

/** Finishes a run (succeeded unless told otherwise). Finishing again with the same status answers with the run. */
export async function finishRun(ctx: RunsContext, id: string, input: FinishAgentRunInput): Promise<AgentRunView> {
  return updateRun(ctx, id, { ...input, status: input.status ?? 'succeeded' });
}

/** One run: a stored run in full, or a turn read as a finished run. */
export async function getRun(ctx: RunsContext, id: string): Promise<AgentRunView> {
  requireAgentsEnabled(ctx.access);
  if (!UUID.test(id)) throw notFound('Run');
  const { data, error } = await ctx.db.from('agent_runs').select('*').eq('id', id).maybeSingle();
  if (missingRunsTable(error)) throw notFound('Run');
  if (error) throw error;
  if (data) return presentRun(ctx.db, await loadRun(ctx, id));
  const { data: turn, error: turnError } = await ctx.db.from('agent_run_feed').select(FEED_COLUMNS).eq('id', id).eq('source', 'turn').maybeSingle();
  if (turnError) throw turnError;
  if (!turn || (turn.agent_id !== ctx.memberId && !canManageRuns(ctx))) throw notFound('Run');
  if (turn.project_id && (await trashedProjectIds(ctx.db)).includes(turn.project_id)) throw notFound('Run');
  const [summary] = await present(ctx.db, [turn as Row]);
  return { ...summary, plan: [], notes: [], metadata: {} };
}

export interface RunFilters {
  /** A member id; null for every agent the key may see. */
  agentId: string | null;
  taskId?: string;
  projectId?: string;
  status?: AgentRunStatus;
  source?: 'run' | 'turn';
  offset: number;
  limit: number;
}

/** Reads the list filters off a query string, refusing what the database would choke on. */
export function runFiltersFrom(ctx: RunsContext, searchParams: URLSearchParams): Omit<RunFilters, 'offset' | 'limit'> {
  const id = (name: string) => {
    const value = searchParams.get(name);
    if (value && !UUID.test(value)) throw badRequest(`${name} must be a uuid`);
    return value ?? undefined;
  };
  const agent = searchParams.get('agent_id');
  if (agent && agent !== 'me' && !UUID.test(agent)) throw badRequest('agent_id must be me or a team member id');
  const manage = canManageRuns(ctx);
  const agentId = agent === 'me' || (!agent && !manage) ? ctx.memberId : agent ?? null;
  if (agentId && agentId !== ctx.memberId && !manage) {
    throw forbidden("Reading another agent's runs needs agents.manage", {
      reason: 'own_runs_only',
      hint: 'Leave agent_id out (or send me) for your own runs.',
    });
  }
  const status = searchParams.get('status');
  if (status && status !== 'all' && !(AGENT_RUN_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`status must be ${AGENT_RUN_STATUSES.join(', ')} or all`);
  }
  const source = searchParams.get('source');
  if (source && !['run', 'turn', 'all'].includes(source)) throw badRequest('source must be run, turn or all');
  return {
    agentId,
    taskId: id('task_id'),
    projectId: id('project_id'),
    status: status && status !== 'all' ? status as AgentRunStatus : undefined,
    source: source === 'run' || source === 'turn' ? source : undefined,
  };
}

/** Runs newest first (a run by its start, a turn by its arrival), stored runs and turns together. */
export async function listRuns(ctx: RunsContext, filters: RunFilters): Promise<{ rows: AgentRunSummary[]; total: number }> {
  requireAgentsEnabled(ctx.access);
  if (ctx.access.principal_id) return listRunsForPrincipal(ctx, filters);
  let query = ctx.db.from('agent_run_feed').select(FEED_COLUMNS, { count: 'exact' });
  if (filters.agentId) query = query.eq('agent_id', filters.agentId);
  if (filters.taskId) query = query.eq('task_id', filters.taskId);
  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.source) query = query.eq('source', filters.source);
  const trashedProjects = await trashedProjectIds(ctx.db);
  if (trashedProjects.length) query = query.or(`project_id.is.null,project_id.not.in.${postgrestList(trashedProjects)}`);
  const trashedTasks = await trashedRunTasks(ctx.db);
  if (trashedTasks.length) query = query.or(`task_id.is.null,task_id.not.in.${postgrestList(trashedTasks)}`);
  const { data, count, error } = await query
    .order('sort_at', { ascending: false })
    .order('id', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (error) throw error;
  return { rows: await present(ctx.db, (data ?? []) as Row[]), total: count ?? 0 };
}

/**
 * Runs while acting for a person (X-Act-For): stored runs only, those
 * runInReach allows (on a project both reach, or on nothing and run for
 * this same person). Turns a host reports carry no person, so they are left
 * out. Newest first, with the feed's filters.
 */
async function listRunsForPrincipal(ctx: RunsContext, filters: RunFilters): Promise<{ rows: AgentRunSummary[]; total: number }> {
  if (filters.source === 'turn') return { rows: [], total: 0 };
  let query = ctx.db.from('agent_runs').select('*', { count: 'exact' }).or(runsReachFilter(ctx) as string);
  if (filters.agentId) query = query.eq('agent_id', filters.agentId);
  if (filters.taskId) query = query.eq('task_id', filters.taskId);
  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  // The feed reads a run two hours past its last update as timed_out; the table stores it as running.
  const stale = new Date(Date.now() - AGENT_RUN_STALE_AFTER_SECONDS * 1000).toISOString();
  if (filters.status === 'timed_out') query = query.eq('status', 'running').lt('updated_at', stale);
  else if (filters.status === 'running') query = query.eq('status', 'running').gte('updated_at', stale);
  else if (filters.status) query = query.eq('status', filters.status);
  const trashedProjects = await trashedProjectIds(ctx.db);
  if (trashedProjects.length) query = query.or(`project_id.is.null,project_id.not.in.${postgrestList(trashedProjects)}`);
  const trashedTasks = await trashedRunTasks(ctx.db);
  if (trashedTasks.length) query = query.or(`task_id.is.null,task_id.not.in.${postgrestList(trashedTasks)}`);
  const { data, count, error } = await query
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (error) throw error;
  return { rows: await presentStoredRuns(ctx.db, (data ?? []) as Row[]), total: count ?? 0 };
}

/**
 * A task's latest stored run, as task reads carry it: anyone who can read
 * the task sees who last ran on it and how it went. Never the trace link,
 * which is the run's own reader's (GET /agents/runs/{id}). A database
 * without the runs table yet reads as none.
 */
export async function latestRunForTask(db: SupabaseClient, taskId: string): Promise<TaskLatestRun | null> {
  const { data, error } = await db
    .from('agent_runs')
    .select('id, status, agent_id, title, started_at, finished_at, updated_at')
    .eq('task_id', taskId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (missingRunsTable(error)) return null;
  if (error) throw error;
  if (!data) return null;
  const names = await memberNames(db, [data.agent_id]);
  return {
    id: data.id,
    status: effectiveRunStatus(data),
    agent_id: data.agent_id,
    agent_name: names.get(data.agent_id) ?? null,
    title: data.title ?? null,
    started_at: data.started_at,
    finished_at: data.finished_at ?? null,
  };
}

/**
 * The run a turn.completed belongs to, from its payload's run_id (the app's
 * run id) or run_external_id (the harness's), among the agent's own runs.
 * Null when it names none, or none of this agent's. A running run it lands
 * on counts it as an update, so a run with live turns never times out.
 * Missing runs never refuse the turn: telemetry is not stalled for a
 * reference.
 */
export async function resolveTurnRun(db: SupabaseClient, agentId: string | null, payload: Row): Promise<string | null> {
  if (!agentId) return null;
  const runId = typeof payload.run_id === 'string' && UUID.test(payload.run_id) ? payload.run_id : null;
  const externalId = typeof payload.run_external_id === 'string' && payload.run_external_id ? payload.run_external_id : null;
  if (!runId && !externalId) return null;
  let query = db.from('agent_runs').select('id, status').eq('agent_id', agentId);
  query = runId ? query.eq('id', runId) : query.eq('external_id', externalId);
  const { data, error } = await query.maybeSingle();
  if (missingRunsTable(error)) return null;
  if (error) throw error;
  if (!data) return null;
  if (data.status === 'running') {
    const { error: touchError } = await db.from('agent_runs').update({ status: 'running' }).eq('id', data.id).eq('status', 'running');
    if (touchError) throw touchError;
  }
  return data.id as string;
}
