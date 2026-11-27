import type { SupabaseClient } from '@supabase/supabase-js';
import {
  INITIATIVE_READ_LIMITS, type Bounded, type CreateInitiativeEntryInput, type CreateInitiativeInput, type InitiativeBriefEntry,
  type InitiativeDetail, type InitiativeEntryView, type InitiativeOwner, type InitiativeProgress, type InitiativeTemplateRun, type InitiativeView,
  type UpdateInitiativeEntryInput, type UpdateInitiativeInput,
} from '@/lib/initiatives';
import { keyDatesOf, mainKeyDate, type TemplateKeyDate } from '@/lib/task-templates';
import type { Initiative, InitiativeEntry, InitiativeEntryKind, InitiativeEntryStatus } from '@/lib/types';
import { restoreFromTrash } from '@/lib/supabase/trash';
import { accessAllowsProject } from './access';
import { callerChannel, callerHolds, type AgentCaller } from './agent-owners';
import { SCOPED_PINNED_LIMITS, missingScopeColumns } from './context-scopes';
import { trashApiError, trashForApi } from './trash';
import { ApiError, badRequest, forbidden, notFound } from './errors';
import { readPage } from './pagination';

/**
 * Initiatives for the API (v1, MCP) and the session routes. Routes run on
 * the service role, so the rules are here (the database holds the same in
 * its row policies, for anything a member reads in the browser):
 * - Reading: whoever can open the project (projects.read and membership, or
 *   projects.read_all), guests included. Progress counts only the tasks the
 *   reader can see: everything in the project with tasks.read, their own
 *   (made by them, assigned to them, or holding such a subtask) with only
 *   tasks.read_assigned, nothing without either.
 * - Creating and changing: tasks.create in the project.
 * - Trash and restore: projects.manage, or whoever made it.
 * - The log: the right to comment on the project's tasks (tasks.read), never
 *   a guest. Its author edits an entry's title, body and task; anyone who may
 *   log resolves or reopens an issue; Trash is its author's or projects.manage.
 * - The brief: context scope 'initiative' (lib/api/context-scopes.ts), with
 *   project_context.read and project_context.manage as a project's brief.
 * No new permission. Every read is a fixed number of queries.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INITIATIVE_COLUMNS = 'id, project_id, name, description, owner_member_id, owner_group_id, status, health, start_date, target_date, sort_order, created_by, principal_id, created_at, updated_at';
const ENTRY_COLUMNS = 'id, initiative_id, project_id, kind, title, body, task_id, status, resolved_at, resolved_by, created_by, principal_id, created_at, updated_at';

/** A database without the initiative tables or tasks.initiative_id yet (new code before its migration). */
export const missingInitiativesSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code ?? '')
    || /initiative.*(does not exist|schema cache)/i.test(error.message ?? ''));

export const initiativesMigrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Initiatives work once the database update 20261126000100_initiatives.sql is applied', { reason: 'migration_pending' });

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingInitiativesSchema(error)) throw initiativesMigrationPending();
  // A rule the database enforces (a task in another project, an entry on a missing task).
  if (error?.code === '23514' && error.message) throw new ApiError(422, 'VALIDATION_ERROR', error.message, { reason: 'rule' });
  throw error;
}

const unprocessable = (message: string, details: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

// ── Who may do what ─────────────────────────────────────────────────────

const reaches = (caller: AgentCaller, projectId: string) => accessAllowsProject(caller.access, projectId, callerChannel(caller));

/** May create and change initiatives in a project the caller reaches: tasks.create. */
export function canEditInitiatives(caller: AgentCaller): boolean {
  return callerHolds(caller, 'tasks.create');
}

/** May read and add to the log: the right to comment on tasks (tasks.read), never a guest. */
export function canUseLog(caller: AgentCaller): boolean {
  return caller.access.role !== 'guest' && callerHolds(caller, 'tasks.read');
}

/** May move an initiative to Trash or restore it: projects.manage, or its creator. */
export function canTrashInitiative(caller: AgentCaller, row: Pick<Initiative, 'created_by'>): boolean {
  return callerHolds(caller, 'projects.manage') || (!!row.created_by && row.created_by === caller.memberId);
}

const readsBrief = (caller: AgentCaller) => callerHolds(caller, 'project_context.read') || callerHolds(caller, 'project_context.manage');

function requireEdit(caller: AgentCaller): void {
  if (canEditInitiatives(caller)) return;
  throw forbidden('Creating and changing initiatives needs permission to create tasks in the project', {
    reason: 'missing_permission', needs: 'tasks.create',
    hint: 'Ask an Owner to grant you Create tasks, or to make the change.',
  });
}

function requireLog(caller: AgentCaller): void {
  if (canUseLog(caller)) return;
  throw forbidden(caller.access.role === 'guest' ? 'Guests do not read or write initiative logs' : 'The log needs permission to read and comment on the project\'s tasks', {
    reason: caller.access.role === 'guest' ? 'guest' : 'missing_permission', needs: 'tasks.read',
  });
}

/** A live project the caller reaches; anything else reads as missing. */
async function requireProject(service: SupabaseClient, caller: AgentCaller, projectId: string): Promise<{ id: string; name: string }> {
  if (!UUID.test(projectId) || !reaches(caller, projectId)) throw notFound('Project');
  const { data, error } = await service.from('projects').select('id, name').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Project');
  return data as { id: string; name: string };
}

async function loadRow(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string): Promise<Row> {
  await requireProject(service, caller, projectId);
  if (!UUID.test(initiativeId)) throw notFound('Initiative');
  const { data, error } = await service.from('initiatives').select(INITIATIVE_COLUMNS)
    .eq('id', initiativeId).eq('project_id', projectId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  if (!data) throw notFound('Initiative');
  return data as Row;
}

// ── Presenting ──────────────────────────────────────────────────────────

const dateOnly = (value: unknown): string | null => (value ? String(value).slice(0, 10) : null);

function bare(row: Row): Initiative {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    description: row.description ?? '',
    owner_member_id: row.owner_member_id ?? null,
    owner_group_id: row.owner_group_id ?? null,
    status: row.status,
    health: row.health ?? null,
    start_date: dateOnly(row.start_date),
    target_date: dateOnly(row.target_date),
    sort_order: row.sort_order ?? 0,
    created_by: row.created_by ?? null,
    principal_id: row.principal_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Active members and live groups by id: an owner who left, or a group in Trash, is no owner. */
async function owners(service: SupabaseClient, rows: Row[]): Promise<Map<string, InitiativeOwner>> {
  const memberIds = [...new Set(rows.map((r) => r.owner_member_id).filter((id): id is string => !!id))];
  const groupIds = [...new Set(rows.map((r) => r.owner_group_id).filter((id): id is string => !!id))];
  const out = new Map<string, InitiativeOwner>();
  const [members, groups] = await Promise.all([
    memberIds.length ? service.from('team_members').select('id, name, status').in('id', memberIds) : Promise.resolve({ data: [], error: null }),
    groupIds.length ? service.from('groups').select('id, name').in('id', groupIds).is('deleted_at', null) : Promise.resolve({ data: [], error: null }),
  ]);
  if (members.error) throw members.error;
  if (groups.error) throw groups.error;
  for (const m of (members.data ?? []) as Row[]) {
    if ((m.status ?? 'active') === 'active') out.set(`member:${m.id}`, { kind: 'member', id: m.id, name: m.name });
  }
  for (const g of (groups.data ?? []) as Row[]) out.set(`group:${g.id}`, { kind: 'group', id: g.id, name: g.name });
  return out;
}

function ownerOf(row: Row, named: Map<string, InitiativeOwner>): InitiativeOwner | null {
  if (row.owner_member_id) return named.get(`member:${row.owner_member_id}`) ?? null;
  if (row.owner_group_id) return named.get(`group:${row.owner_group_id}`) ?? null;
  return null;
}

async function idsIn<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await read(ids.slice(i, i + 100));
    if (error) fail(error as { code?: string; message?: string });
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/**
 * Top-level tasks done and in all per initiative, of the tasks the caller
 * can see. One grouped count for whoever reads every task in the project;
 * for tasks.read_assigned alone, only their own (made by them, assigned to
 * them, or with such a subtask); null for someone who reads no tasks.
 */
async function progressFor(service: SupabaseClient, caller: AgentCaller, ids: string[]): Promise<Map<string, InitiativeProgress> | null> {
  if (!ids.length) return new Map();
  if (callerHolds(caller, 'tasks.read')) {
    const { data, error } = await service.from('initiative_progress').select('initiative_id, total, done').in('initiative_id', ids);
    if (error) fail(error);
    return new Map(((data ?? []) as Row[]).map((r) => [r.initiative_id as string, { done: r.done ?? 0, total: r.total ?? 0 }]));
  }
  if (!callerHolds(caller, 'tasks.read_assigned')) return null;
  const me = caller.memberId;
  const tops = await idsIn<Row>(ids, (chunk) => service.from('tasks').select('id, initiative_id, status, created_by')
    .in('initiative_id', chunk).is('parent_task_id', null).is('deleted_at', null));
  const topIds = tops.map((t) => t.id as string);
  const children = await idsIn<Row>(topIds, (chunk) => service.from('tasks').select('id, parent_task_id, created_by')
    .in('parent_task_id', chunk).is('deleted_at', null));
  const assigned = new Set((await idsIn<Row>([...topIds, ...children.map((c) => c.id as string)], (chunk) => service.from('task_assignees')
    .select('task_id').eq('member_id', me).in('task_id', chunk))).map((a) => a.task_id as string));
  const viaChild = new Set(children.filter((c) => c.created_by === me || assigned.has(c.id)).map((c) => c.parent_task_id as string));
  const out = new Map<string, InitiativeProgress>();
  for (const task of tops) {
    if (!(task.created_by === me || assigned.has(task.id) || viaChild.has(task.id))) continue;
    const row = out.get(task.initiative_id) ?? { done: 0, total: 0 };
    row.total += 1;
    if (task.status === 'done') row.done += 1;
    out.set(task.initiative_id, row);
  }
  return out;
}

async function logStats(service: SupabaseClient, ids: string[]): Promise<Map<string, { open_issues: number; last_entry_at: string | null }>> {
  if (!ids.length) return new Map();
  const { data, error } = await service.from('initiative_log_stats').select('initiative_id, open_issues, last_entry_at').in('initiative_id', ids);
  if (error) fail(error);
  return new Map(((data ?? []) as Row[]).map((r) => [r.initiative_id as string, { open_issues: r.open_issues ?? 0, last_entry_at: r.last_entry_at ?? null }]));
}

async function present(service: SupabaseClient, caller: AgentCaller, rows: Row[]): Promise<InitiativeView[]> {
  const ids = rows.map((r) => r.id as string);
  const log = canUseLog(caller);
  const [named, progress, stats] = await Promise.all([
    owners(service, rows),
    progressFor(service, caller, ids),
    log ? logStats(service, ids) : Promise.resolve(null),
  ]);
  return rows.map((row) => ({
    ...bare(row),
    owner: ownerOf(row, named),
    progress: progress ? progress.get(row.id) ?? { done: 0, total: 0 } : null,
    open_issue_count: stats ? stats.get(row.id)?.open_issues ?? 0 : null,
    last_entry_at: stats ? stats.get(row.id)?.last_entry_at ?? null : null,
  }));
}

async function memberNames(service: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('team_members').select('id, name').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as Row[]).map((m) => [m.id as string, m.name as string]));
}

function bareEntry(row: Row): InitiativeEntry {
  return {
    id: row.id,
    initiative_id: row.initiative_id,
    project_id: row.project_id,
    kind: row.kind as InitiativeEntryKind,
    title: row.title,
    body: row.body ?? '',
    task_id: row.task_id ?? null,
    status: (row.status ?? null) as InitiativeEntryStatus | null,
    resolved_at: row.resolved_at ?? null,
    resolved_by: row.resolved_by ?? null,
    created_by: row.created_by ?? null,
    principal_id: row.principal_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function presentEntries(service: SupabaseClient, rows: Row[]): Promise<InitiativeEntryView[]> {
  const names = await memberNames(service, rows.flatMap((r) => [r.created_by, r.resolved_by]));
  return rows.map((row) => ({
    ...bareEntry(row),
    created_by_name: row.created_by ? names.get(row.created_by) ?? null : null,
    resolved_by_name: row.resolved_by ? names.get(row.resolved_by) ?? null : null,
  }));
}

// ── Reading ─────────────────────────────────────────────────────────────

export interface InitiativeFilters {
  /** Done ones are left out unless asked for ("Show done"). */
  include_done?: boolean;
  status?: Initiative['status'] | null;
  offset: number;
  limit: number;
}

export function initiativeFiltersFrom(searchParams: URLSearchParams): Omit<InitiativeFilters, 'offset' | 'limit'> {
  const status = searchParams.get('status');
  if (status && !['planned', 'active', 'paused', 'done'].includes(status)) {
    throw unprocessable('status is planned, active, paused or done', { reason: 'invalid_filter' });
  }
  return { include_done: searchParams.get('include_done') === 'true', status: (status as Initiative['status'] | null) || null };
}

/** A project's initiatives in order, with owner, progress and the log's open issues, paged. */
export async function listInitiatives(
  service: SupabaseClient,
  caller: AgentCaller,
  projectId: string,
  filters: InitiativeFilters,
): Promise<{ rows: InitiativeView[]; total: number }> {
  await requireProject(service, caller, projectId);
  let query = service.from('initiatives').select(INITIATIVE_COLUMNS, { count: 'exact' }).eq('project_id', projectId).is('deleted_at', null);
  if (filters.status) query = query.eq('status', filters.status);
  else if (!filters.include_done) query = query.neq('status', 'done');
  const { data, count, error } = await readPage(query.order('sort_order').order('created_at').order('id'), filters);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  return { rows: await present(service, caller, rows), total: count ?? rows.length };
}

const cut = (text: string, max: number) => (text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false });

/** The initiative's pinned brief entries, newest first, at most SCOPED_PINNED_LIMITS.perScope. null before the update. */
export async function pinnedInitiativeBrief(service: SupabaseClient, initiativeId: string): Promise<Bounded<InitiativeBriefEntry> | null> {
  const { data, error, count } = await service.from('project_context').select('id, section, content', { count: 'exact' })
    .eq('scope_type', 'initiative').eq('scope_id', initiativeId).eq('pinned', true).eq('is_active', true)
    .order('updated_at', { ascending: false }).limit(SCOPED_PINNED_LIMITS.perScope);
  if (missingScopeColumns(error) || error?.code === '23514') return null;
  if (error) throw error;
  const rows = ((data ?? []) as Row[]).map((row) => {
    const content = cut(String(row.content ?? ''), SCOPED_PINNED_LIMITS.entry);
    return { id: row.id as string, section: row.section as string, content: content.text, ...(content.truncated ? { content_truncated: true } : {}) };
  });
  return { rows, more: Math.max(0, (count ?? rows.length) - rows.length) };
}

async function boundedEntries(service: SupabaseClient, initiativeId: string, limit: number, openIssues: boolean): Promise<Bounded<InitiativeEntryView>> {
  let query = service.from('initiative_entries').select(ENTRY_COLUMNS, { count: 'exact' }).eq('initiative_id', initiativeId).is('deleted_at', null);
  if (openIssues) query = query.eq('kind', 'issue').eq('status', 'open');
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id').limit(limit);
  if (error) fail(error);
  const rows = await presentEntries(service, (data ?? []) as Row[]);
  return { rows, more: Math.max(0, (count ?? rows.length) - rows.length) };
}

/**
 * The template run that made this initiative (task_template_runs.initiative_id),
 * with its key dates labelled from the run's own snapshot, in the template's
 * order; null when no run made it, or before the templates update.
 */
export async function initiativeTemplateRun(service: SupabaseClient, initiativeId: string): Promise<InitiativeTemplateRun | null> {
  const { data, error } = await service.from('task_template_runs')
    .select('id, template_id, snapshot, key_dates, start_date, created_at, run_by_member:team_members(name)')
    .eq('initiative_id', initiativeId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    // A database before templates v2 has no initiative_id on runs: no run made it.
    if (['42P01', '42703', 'PGRST205', 'PGRST204', 'PGRST200'].includes(error.code ?? '') || /initiative_id|task_template_runs/.test(error.message ?? '')) return null;
    throw error;
  }
  const run = data as Row | null;
  if (!run) return null;
  const snapshot = (run.snapshot ?? {}) as { name?: string; key_dates?: TemplateKeyDate[] };
  const list = keyDatesOf(Array.isArray(snapshot.key_dates) ? snapshot.key_dates : null);
  const main = mainKeyDate(list).key;
  const stored = run.key_dates && typeof run.key_dates === 'object' ? run.key_dates as Record<string, string> : {};
  const startDate = typeof run.start_date === 'string' ? run.start_date.slice(0, 10) : null;
  const dates: Record<string, string> = Object.keys(stored).length ? stored : (startDate ? { start: startDate } : {});
  const runBy = Array.isArray(run.run_by_member) ? run.run_by_member[0] : run.run_by_member;
  return {
    run_id: run.id,
    template_id: run.template_id,
    template_name: String(snapshot.name ?? ''),
    key_dates: list.filter((keyDate) => dates[keyDate.key]).map((keyDate) => ({
      key: keyDate.key, label: keyDate.label, date: String(dates[keyDate.key]).slice(0, 10), main: keyDate.key === main,
    })),
    run_by_name: (runBy?.name as string | undefined) ?? null,
    created_at: run.created_at,
  };
}

/**
 * One initiative's starting read: the header with progress, its open issues
 * (newest 20) and last 10 entries for whoever may read the log, its pinned
 * brief entries for whoever reads project context, the template run that
 * made it (null when none did), and what the reader may do. `more` says how many were left out.
 */
export async function getInitiative(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string): Promise<InitiativeDetail> {
  const row = await loadRow(service, caller, projectId, initiativeId);
  const log = canUseLog(caller);
  const brief = readsBrief(caller);
  const [[view], openIssues, recent, pinned, templateRun] = await Promise.all([
    present(service, caller, [row]),
    log ? boundedEntries(service, row.id, INITIATIVE_READ_LIMITS.openIssues, true) : Promise.resolve(null),
    log ? boundedEntries(service, row.id, INITIATIVE_READ_LIMITS.recentEntries, false) : Promise.resolve(null),
    brief ? pinnedInitiativeBrief(service, row.id) : Promise.resolve(null),
    initiativeTemplateRun(service, row.id),
  ]);
  return {
    initiative: view,
    template_run: templateRun,
    open_issues: openIssues,
    recent_entries: recent,
    brief: pinned,
    can: {
      edit: canEditInitiatives(caller),
      trash: canTrashInitiative(caller, row as Initiative),
      log,
      read_brief: brief,
      edit_brief: callerHolds(caller, 'project_context.manage'),
    },
  };
}

/** One initiative as lists show it (the header alone). */
export async function getInitiativeView(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string): Promise<InitiativeView> {
  const row = await loadRow(service, caller, projectId, initiativeId);
  return (await present(service, caller, [row]))[0];
}

// ── Writing ─────────────────────────────────────────────────────────────

/** An owner must be an active member or a live group. */
async function checkOwner(service: SupabaseClient, input: { owner_member_id?: string | null; owner_group_id?: string | null }): Promise<void> {
  if (input.owner_member_id) {
    const { data, error } = await service.from('team_members').select('id, status').eq('id', input.owner_member_id).maybeSingle();
    if (error) throw error;
    if (!data || ((data as Row).status ?? 'active') !== 'active') {
      throw unprocessable('The owner must be an active team member', { reason: 'owner_not_found', fields: { owner_member_id: 'Pick an active team member.' } });
    }
  }
  if (input.owner_group_id) {
    const { data, error } = await service.from('groups').select('id').eq('id', input.owner_group_id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) throw unprocessable('The owner group is not there or is in Trash', { reason: 'owner_not_found', fields: { owner_group_id: 'Pick a group.' } });
  }
}

/** Health belongs to an active initiative. */
function checkHealth(status: Initiative['status'], health: Initiative['health'] | undefined): void {
  if (health && status !== 'active') {
    throw unprocessable('Health is set only while the initiative is active', { reason: 'health_needs_active', fields: { health: 'Set the status to Active first.' } });
  }
}

/**
 * Creates an initiative in a project (tasks.create there). The one way an
 * initiative is made, for the screens, the API, MCP and, later, templates.
 * It goes last in the project's order unless sort_order says otherwise.
 */
export async function createInitiative(service: SupabaseClient, caller: AgentCaller, projectId: string, input: CreateInitiativeInput): Promise<InitiativeView> {
  await requireProject(service, caller, projectId);
  requireEdit(caller);
  const status = input.status ?? 'planned';
  checkHealth(status, input.health);
  await checkOwner(service, input);
  let sortOrder = input.sort_order;
  if (sortOrder === undefined) {
    const { data, error } = await service.from('initiatives').select('sort_order').eq('project_id', projectId).is('deleted_at', null)
      .order('sort_order', { ascending: false }).limit(1).maybeSingle();
    if (error) fail(error);
    sortOrder = data ? ((data as Row).sort_order ?? 0) + 1 : 0;
  }
  const { data, error } = await service.from('initiatives').insert({
    project_id: projectId,
    name: input.name,
    description: input.description ?? '',
    owner_member_id: input.owner_member_id ?? null,
    owner_group_id: input.owner_group_id ?? null,
    status,
    health: input.health ?? null,
    start_date: input.start_date ?? null,
    target_date: input.target_date ?? null,
    sort_order: sortOrder,
    created_by: caller.memberId,
  }).select(INITIATIVE_COLUMNS).single();
  if (error) fail(error);
  return (await present(service, caller, [data as Row]))[0];
}

/**
 * Changes an initiative: only what is sent. Naming a member owner clears a
 * group owner and the other way round (one owner at most). Health is
 * cleared when it stops being active.
 */
export async function updateInitiative(
  service: SupabaseClient,
  caller: AgentCaller,
  projectId: string,
  initiativeId: string,
  input: UpdateInitiativeInput,
): Promise<{ before: InitiativeView; initiative: InitiativeView }> {
  const row = await loadRow(service, caller, projectId, initiativeId);
  requireEdit(caller);
  const status = input.status ?? row.status;
  // Leaving active clears a health nobody resent (the database does the same).
  checkHealth(status, input.health !== undefined ? input.health : status === 'active' ? row.health : null);
  await checkOwner(service, input);
  const [before] = await present(service, caller, [row]);
  const changes: Row = {};
  for (const key of ['name', 'description', 'status', 'health', 'start_date', 'target_date', 'sort_order'] as const) {
    if (input[key] !== undefined) changes[key] = input[key];
  }
  if (input.owner_member_id !== undefined) {
    changes.owner_member_id = input.owner_member_id;
    if (input.owner_member_id) changes.owner_group_id = null;
  }
  if (input.owner_group_id !== undefined) {
    changes.owner_group_id = input.owner_group_id;
    if (input.owner_group_id) changes.owner_member_id = null;
  }
  const start = changes.start_date !== undefined ? changes.start_date : dateOnly(row.start_date);
  const target = changes.target_date !== undefined ? changes.target_date : dateOnly(row.target_date);
  if (start && target && target < start) {
    throw unprocessable('The target date cannot be before the start date', { reason: 'dates_order', fields: { target_date: 'Pick a date on or after the start date.' } });
  }
  if (Object.keys(changes).length === 0) return { before, initiative: before };
  const { data, error } = await service.from('initiatives').update(changes).eq('id', initiativeId).is('deleted_at', null).select(INITIATIVE_COLUMNS).single();
  if (error) fail(error);
  return { before, initiative: (await present(service, caller, [data as Row]))[0] };
}

function requireTrash(caller: AgentCaller, row: Row): void {
  if (canTrashInitiative(caller, row as Initiative)) return;
  throw forbidden('Only whoever made it, or someone who manages projects, moves an initiative to Trash', {
    reason: 'missing_permission', needs: 'projects.manage',
  });
}

/**
 * Moves an initiative to Trash (Settings > Trash lists and restores it). Its
 * tasks stay as they are: they keep the link and read as having no
 * initiative until it is restored. Its log goes out of reach with it.
 */
export async function trashInitiative(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string): Promise<InitiativeView> {
  const row = await loadRow(service, caller, projectId, initiativeId);
  requireTrash(caller, row);
  const [view] = await present(service, caller, [row]);
  await trashForApi(service, 'initiatives', initiativeId, caller.memberId, 'Initiative');
  return view;
}

/** Brings an initiative back from Trash, its tasks with it (they never let go). */
export async function restoreInitiative(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string): Promise<InitiativeView> {
  await requireProject(service, caller, projectId);
  if (!UUID.test(initiativeId)) throw notFound('Initiative');
  const { data, error } = await service.from('initiatives').select(INITIATIVE_COLUMNS).eq('id', initiativeId).eq('project_id', projectId)
    .not('deleted_at', 'is', null).maybeSingle(); // includes-deleted: restoring reads the one in Trash
  if (error) fail(error);
  if (!data) throw notFound('Initiative in Trash');
  requireTrash(caller, data as Row);
  try {
    await restoreFromTrash(service, 'initiatives', initiativeId, caller.memberId);
  } catch (trashError) {
    throw trashApiError(trashError, 'Initiative');
  }
  return getInitiativeView(service, caller, projectId, initiativeId);
}

// ── The log ─────────────────────────────────────────────────────────────

export interface EntryFilters {
  kind?: InitiativeEntryKind | null;
  status?: InitiativeEntryStatus | null;
  offset: number;
  limit: number;
}

export function entryFiltersFrom(searchParams: URLSearchParams): Omit<EntryFilters, 'offset' | 'limit'> {
  const kind = searchParams.get('kind');
  const status = searchParams.get('status');
  if (kind && !['update', 'decision', 'issue', 'note'].includes(kind)) throw unprocessable('kind is update, decision, issue or note', { reason: 'invalid_filter' });
  if (status && !['open', 'resolved'].includes(status)) throw unprocessable('status is open or resolved', { reason: 'invalid_filter' });
  return { kind: (kind as InitiativeEntryKind | null) || null, status: (status as InitiativeEntryStatus | null) || null };
}

/** An initiative's log, newest first, paged (50 a page by default). */
export async function listEntries(
  service: SupabaseClient,
  caller: AgentCaller,
  projectId: string,
  initiativeId: string,
  filters: EntryFilters,
): Promise<{ rows: InitiativeEntryView[]; total: number }> {
  await loadRow(service, caller, projectId, initiativeId);
  requireLog(caller);
  let query = service.from('initiative_entries').select(ENTRY_COLUMNS, { count: 'exact' }).eq('initiative_id', initiativeId).is('deleted_at', null);
  if (filters.kind) query = query.eq('kind', filters.kind);
  if (filters.status) query = query.eq('status', filters.status);
  const { data, count, error } = await readPage(query.order('created_at', { ascending: false }).order('id'), filters);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  return { rows: await presentEntries(service, rows), total: count ?? rows.length };
}

/** A task an entry names must be live and in the initiative's project. */
async function checkEntryTask(service: SupabaseClient, taskId: string | null | undefined, projectId: string): Promise<void> {
  if (!taskId) return;
  const { data, error } = await service.from('tasks').select('id, project_id').eq('id', taskId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data || (data as Row).project_id !== projectId) {
    throw unprocessable('task_id must name a task in this project', { reason: 'task_not_in_project', fields: { task_id: 'Pick a task in this project.' } });
  }
}

/** Adds an entry to the log, as the caller. An issue starts open. */
export async function addEntry(
  service: SupabaseClient,
  caller: AgentCaller,
  projectId: string,
  initiativeId: string,
  input: CreateInitiativeEntryInput,
): Promise<InitiativeEntryView> {
  await loadRow(service, caller, projectId, initiativeId);
  requireLog(caller);
  await checkEntryTask(service, input.task_id, projectId);
  const { data, error } = await service.from('initiative_entries').insert({
    initiative_id: initiativeId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? '',
    task_id: input.task_id ?? null,
    created_by: caller.memberId,
  }).select(ENTRY_COLUMNS).single();
  if (error) fail(error);
  return (await presentEntries(service, [data as Row]))[0];
}

async function loadEntry(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string, entryId: string): Promise<Row> {
  await loadRow(service, caller, projectId, initiativeId);
  requireLog(caller);
  if (!UUID.test(entryId)) throw notFound('Log entry');
  const { data, error } = await service.from('initiative_entries').select(ENTRY_COLUMNS)
    .eq('id', entryId).eq('initiative_id', initiativeId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  if (!data) throw notFound('Log entry');
  return data as Row;
}

/**
 * Changes an entry. Its title, body and task are its author's to change;
 * status resolves or reopens an issue, for anyone who may log.
 */
export async function updateEntry(
  service: SupabaseClient,
  caller: AgentCaller,
  projectId: string,
  initiativeId: string,
  entryId: string,
  input: UpdateInitiativeEntryInput,
): Promise<{ before: InitiativeEntryView; entry: InitiativeEntryView }> {
  const row = await loadEntry(service, caller, projectId, initiativeId, entryId);
  const authorFields = input.title !== undefined || input.body !== undefined || input.task_id !== undefined;
  if (authorFields && row.created_by !== caller.memberId) {
    throw forbidden('Only its author changes an entry\'s title, body or task', { reason: 'not_author' });
  }
  if (input.status !== undefined && row.kind !== 'issue') {
    throw unprocessable('Only an issue is resolved or reopened', { reason: 'not_an_issue', fields: { status: 'Only issues have a status.' } });
  }
  if (input.task_id !== undefined) await checkEntryTask(service, input.task_id, projectId);
  const [before] = await presentEntries(service, [row]);
  const changes: Row = {};
  if (input.title !== undefined) changes.title = input.title;
  if (input.body !== undefined) changes.body = input.body;
  if (input.task_id !== undefined) changes.task_id = input.task_id;
  if (input.status !== undefined && input.status !== row.status) {
    changes.status = input.status;
    changes.resolved_by = input.status === 'resolved' ? caller.memberId : null;
  }
  if (Object.keys(changes).length === 0) return { before, entry: before };
  const { data, error } = await service.from('initiative_entries').update(changes).eq('id', entryId).is('deleted_at', null).select(ENTRY_COLUMNS).single();
  if (error) fail(error);
  return { before, entry: (await presentEntries(service, [data as Row]))[0] };
}

/** Moves an entry to Trash: its author's, or whoever manages projects. */
export async function trashEntry(service: SupabaseClient, caller: AgentCaller, projectId: string, initiativeId: string, entryId: string): Promise<InitiativeEntryView> {
  const row = await loadEntry(service, caller, projectId, initiativeId, entryId);
  if (row.created_by !== caller.memberId && !callerHolds(caller, 'projects.manage')) {
    throw forbidden('Only its author, or someone who manages projects, moves an entry to Trash', { reason: 'not_author' });
  }
  const [view] = await presentEntries(service, [row]);
  await trashForApi(service, 'initiative_entries', entryId, caller.memberId, 'Log entry');
  return view;
}

// ── Tasks ───────────────────────────────────────────────────────────────

/**
 * A task's initiative, as a task write names it: a live initiative in the
 * task's project (400 otherwise; 503 before the update). The database holds
 * the same rule; this answers it in words before anything is written.
 */
export async function assertInitiativeInProject(supabase: SupabaseClient, initiativeId: string | null | undefined, projectId: string): Promise<void> {
  if (!initiativeId) return;
  if (!UUID.test(initiativeId)) throw badRequest('initiative_id must be a uuid');
  const { data, error } = await supabase.from('initiatives').select('id, project_id').eq('id', initiativeId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  if (!data || (data as Row).project_id !== projectId) {
    throw badRequest('initiative_id must name an initiative in the task\'s own project (not one in Trash)', { reason: 'initiative_not_in_project' });
  }
}

/**
 * A subtask always has its parent's initiative: naming another is refused.
 * Reads the parent's only when the write names one.
 */
export async function assertSubtaskInitiative(supabase: SupabaseClient, parentId: string, initiativeId: string | null | undefined): Promise<void> {
  if (initiativeId === undefined) return;
  const { data, error } = await supabase.from('tasks').select('initiative_id').eq('id', parentId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  if (((data as Row | null)?.initiative_id ?? null) !== (initiativeId ?? null)) {
    throw badRequest('A subtask is always in its parent task\'s initiative: leave out initiative_id, or change the parent\'s', { reason: 'subtask_initiative' });
  }
}

/**
 * The initiative a task brief carries: its header and pinned brief entries,
 * null when the task has none, it is in Trash, or the tables are not there
 * yet. The description is cut to fit.
 */
export async function initiativeForBrief(
  supabase: SupabaseClient,
  initiativeId: string | null | undefined,
  options: { withBrief: boolean; descriptionMax: number },
): Promise<Row | null> {
  if (!initiativeId) return null;
  const { data, error } = await supabase.from('initiatives').select(INITIATIVE_COLUMNS).eq('id', initiativeId).is('deleted_at', null).maybeSingle();
  if (missingInitiativesSchema(error)) return null;
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  const named = await owners(supabase, [row]);
  const description = cut(String(row.description ?? ''), options.descriptionMax);
  return {
    id: row.id,
    name: row.name,
    description: description.text,
    ...(description.truncated ? { description_truncated: true } : {}),
    status: row.status,
    health: row.health ?? null,
    owner: ownerOf(row, named),
    start_date: dateOnly(row.start_date),
    target_date: dateOnly(row.target_date),
    brief: options.withBrief ? await pinnedInitiativeBrief(supabase, row.id) : null,
  };
}
