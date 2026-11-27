import type { SupabaseClient } from '@supabase/supabase-js';
import { apiScopesFor } from '@/lib/access-control';
import {
  addDays, dateInZone, daysBetween, describeRecurrence, lastOnOrBefore, nextAfter, nextOnOrAfter, OCCURRENCE_REASON_WORDS, scheduleFills,
  upcomingDates, zonedMidnight, type OccurrenceStatus, type Recurrence, type RepeatMode, type ScheduleKind, type ScheduleOccurrenceView,
  type ScheduleStatus, type ScheduleUpdateInput, type ScheduleView, type TaskRepeatInput, type TemplateScheduleInput, inScheduleRange, isTimeZone, recurrenceSchema,
} from '@/lib/schedules';
import { readEnabledModules } from '@/lib/modules/server';
import { keyDatesOf, templateIssue, type RunTaskTemplateInput, type TemplateField, type TemplateKeyDate } from '@/lib/task-templates';
import { insertTask } from '@/lib/supabase/queries';
import { moveToTrash } from '@/lib/supabase/trash';
import { ensureSchedulerSecret } from '@/lib/webhooks/retries';
import { savedInApp } from '@/lib/secrets/store';
import { accessAllowsProject, resolveMemberAccess } from './access';
import { callerChannel, callerHolds, type AgentCaller } from './agent-owners';
import { loadMemberRules } from './agent-rules';
import { agentIdsAmong, mayGiveAgentWork, notifyAgentManagers, workGiverOf } from './agent-access';
import { requireAssistantSwitch } from './assistant';
import { ApiError, badRequest, forbidden, notFound } from './errors';
import { subtaskRuleError } from './subtasks';
import { readPage } from './pagination';
import { apiDateOf } from '@/lib/schemas/shared';
import {
  canManageTemplates, canRunTemplates, canWriteTemplate, createTemplateRun, loadTemplateRow, memberNames, prepareRun, projectNames, templateErrors,
} from './task-templates';

/**
 * Schedules (20261126000400_schedules.sql): one scheduler for recurring
 * templates and repeating tasks.
 *
 * Who may do what (the same rules over the app, REST and MCP):
 * - A template schedule: setting one up is using the template on a
 *   schedule, so it needs what a run needs (tasks.create on the project, the
 *   template readable) and is checked like a run for its first date (every
 *   error with its path). Whoever set it up, or whoever may change the
 *   template, may change, pause or remove it.
 * - A task repeat: whoever may edit the task (tasks.manage_all, or
 *   tasks.manage_assigned on a task they are on) and create tasks in its
 *   project. Top-level tasks only.
 * - Reading: schedules on projects the caller can open.
 * - run_as is whose rights each run uses: whoever set it up or last changed
 *   what it makes (project, recurrence, roles, values, offsets). Checked at
 *   run time; losing them pauses the schedule and tells them.
 *
 * The engine (runDueSchedules, from /api/internal/schedules/run): each due
 * schedule's occurrence is claimed by moving next_run_at on atomically
 * (pm.claim_schedule_occurrence), with (schedule_id, scheduled_for) unique
 * as a backstop, so two runners never make one twice. After downtime only
 * the latest missed date runs, its dates anchored to that date. A failure
 * is logged and tried once more on the next tick, then the schedule pauses
 * with a notification. A template run goes through createTemplateRun (via
 * schedule); a task copy through save_task, so activity, events and
 * webhooks follow as for any task.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, kind, template_id, task_id, project_id, recurrence, timezone, start_date, end_date, mode, role_members, field_values, key_date_offsets, create_initiative, skip_if_open, status, paused_reason, next_on, next_run_at, done_on, last_run_at, last_outcome, last_reason, run_as, created_by, updated_by, created_at, updated_at';
const OCCURRENCE_COLUMNS = 'id, schedule_id, scheduled_for, status, reason, error, attempts, run_id, task_id, source_task_id, started_at, finished_at';
/** A running occurrence older than this stopped before it finished. */
const STALE_MS = 15 * 60_000;
const SUBTASK_BATCH = 10;

export const missingSchedulesSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', 'PGRST205', 'PGRST202'].includes(error.code ?? '') || /schedules|schedule_occurrences|claim_schedule_occurrence/.test(error.message ?? '') && /does not exist|schema cache|could not find/i.test(error.message ?? ''));

const migrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Schedules need the database update 20261126000400_schedules.sql. Apply it (npm run db:migrate), then try again.', { reason: 'migration_pending' });

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingSchedulesSchema(error)) throw migrationPending();
  throw error;
}

const unprocessable = (message: string, path: string, code: string, hint: string) => new ApiError(422, 'VALIDATION_ERROR', message, {
  reason: code, errors: [{ path, code, message, hint }],
});

/** Calendar dates as YYYY-MM-DD, however the client read them. */
const day = (value: unknown): string | null => (value == null ? null : String(value).slice(0, 10));
const normalize = (row: Row): Row => ({
  ...row, start_date: day(row.start_date), end_date: day(row.end_date), next_on: day(row.next_on), done_on: day(row.done_on),
});
const normalizeTask = (row: Row): Row => ({ ...row, due_date: day(row.due_date) });

const reaches = (caller: AgentCaller, projectId: string) => accessAllowsProject(caller.access, projectId, callerChannel(caller));

// ── Time ────────────────────────────────────────────────────────────────

/** The workspace's time zone (the first Owner's), UTC when none. */
export async function workspaceZone(service: SupabaseClient): Promise<string> {
  const { data, error } = await service.rpc('workspace_timezone');
  const zone = !error && typeof data === 'string' ? data : 'UTC';
  return isTimeZone(zone) ? zone : 'UTC';
}

/** Whether the database can wake the app to run schedules (the scheduler secret is set up). */
export async function schedulerReady(service: SupabaseClient): Promise<boolean> {
  if (process.env.WEBHOOK_SCHEDULER_ENABLED === 'true') return true;
  try { return await savedInApp(service, 'webhook_scheduler_secret'); } catch { return false; }
}

const todayIn = (zone: string, now: Date) => {
  try { return dateInZone(now, zone); } catch { return dateInZone(now, 'UTC'); }
};
const startOf = (date: string, zone: string) => {
  try { return zonedMidnight(date, zone).toISOString(); } catch { return zonedMidnight(date, 'UTC').toISOString(); }
};

/** What the scheduler holds next: the date, when it runs, and whether it ended. */
interface ScheduleState {
  next_on: string | null;
  next_run_at: string | null;
  done_on: string | null;
  status: ScheduleStatus;
}

/**
 * Where a schedule starts (set up, changed or resumed): a template's next
 * run date on or after today; a task's next copy is due on the date after
 * the task's own due date, made when the task falls due (or, overdue, on
 * the latest date of the recurrence up to today, so it runs at once); an
 * after_done repeat waits for the task to be completed (now, when it is).
 */
export function initialState(input: {
  kind: ScheduleKind; mode: RepeatMode; rule: Recurrence; start: string; end: string | null; zone: string;
  sourceDue?: string | null; sourceDone?: boolean;
}, now: Date): ScheduleState {
  const today = todayIn(input.zone, now);
  const ended: ScheduleState = { next_on: null, next_run_at: null, done_on: null, status: 'ended' };
  if (input.kind === 'template') {
    const next = nextOnOrAfter(input.rule, input.start, today < input.start ? input.start : today);
    if (input.end && next > input.end) return ended;
    return { next_on: next, next_run_at: startOf(next, input.zone), done_on: null, status: 'active' };
  }
  if (input.mode === 'after_done') {
    return input.sourceDone
      ? { next_on: null, next_run_at: now.toISOString(), done_on: today, status: 'active' }
      : { next_on: null, next_run_at: null, done_on: null, status: 'active' };
  }
  let fire = input.sourceDue ?? today;
  if (fire < today) {
    const latest = lastOnOrBefore(input.rule, input.start, today);
    if (latest && latest > fire) fire = latest;
  }
  const next = nextAfter(input.rule, input.start, fire);
  if (input.end && next > input.end) return ended;
  return { next_on: next, next_run_at: startOf(fire, input.zone), done_on: null, status: 'active' };
}

/**
 * A template schedule's next date moved past the dates that already made
 * their run (or are making it), so what a resume or change answers is what
 * happens: a date that made nothing (skipped, failed twice) runs again
 * (pm.claim_schedule_occurrence claims it again); one that made its run is
 * never made twice, so the answer names the date after it.
 */
async function pastMadeDates(service: SupabaseClient, row: Row, scheduleId: string): Promise<Partial<ScheduleState>> {
  if (row.status !== 'active' || !row.next_on) return {};
  const rule = row.recurrence as Recurrence;
  const { data, error } = await service.from('schedule_occurrences').select('scheduled_for').eq('schedule_id', scheduleId)
    .in('status', ['created', 'running']).gte('scheduled_for', row.next_on).order('scheduled_for').limit(50);
  if (error) fail(error);
  const made = new Set(((data ?? []) as Row[]).map((o) => day(o.scheduled_for)));
  let next = row.next_on as string;
  while (made.has(next)) next = nextAfter(rule, row.start_date, next);
  if (next === row.next_on) return {};
  if (row.end_date && next > row.end_date) return { next_on: null, next_run_at: null, status: 'ended' };
  return { next_on: next, next_run_at: startOf(next, row.timezone) };
}

// ── Presenting ──────────────────────────────────────────────────────────

const objectOf = <T,>(value: unknown): Record<string, T> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {});

function present(row: Row, maps: { projects: Map<string, string>; templates: Map<string, string>; tasks: Map<string, string>; names: Map<string, string>; trashedTemplates: Set<string> }, canEdit: boolean, now = new Date()): ScheduleView {
  const rule = row.recurrence as Recurrence;
  // A live schedule whose template is in Trash cannot run: it reads as paused
  // for that reason now, not only on its next date (when the engine pauses it).
  if (row.status === 'active' && row.kind === 'template' && maps.trashedTemplates.has(row.template_id)) {
    row = { ...row, status: 'paused', paused_reason: 'template_gone' };
  }
  let upcoming: string[] = [];
  if (row.status === 'active' && row.next_on) {
    try { upcoming = upcomingDates(rule, row.start_date, row.next_on, 5, row.end_date ?? null); } catch { upcoming = []; }
  } else if (row.status === 'paused' && row.kind === 'template' && row.paused_reason !== 'template_gone') {
    try { upcoming = upcomingDates(rule, row.start_date, todayIn(row.timezone, now), 5, row.end_date ?? null); } catch { upcoming = []; }
  }
  let label = '';
  try { label = describeRecurrence(rule); } catch { label = 'Custom'; }
  return {
    id: row.id,
    kind: row.kind,
    template_id: row.template_id ?? null,
    template_name: row.template_id ? maps.templates.get(row.template_id) ?? null : null,
    task_id: row.task_id ?? null,
    task_title: row.task_id ? maps.tasks.get(row.task_id) ?? null : null,
    project_id: row.project_id,
    project_name: maps.projects.get(row.project_id) ?? null,
    recurrence: rule,
    recurrence_label: label,
    timezone: row.timezone,
    start_date: row.start_date,
    end_date: row.end_date ?? null,
    mode: row.mode,
    roles: objectOf<string | null>(row.role_members),
    values: objectOf<string>(row.field_values),
    key_date_offsets: objectOf<number>(row.key_date_offsets),
    create_initiative: !!row.create_initiative,
    skip_if_open: row.skip_if_open !== false,
    status: row.status,
    paused_reason: row.paused_reason ?? null,
    next_on: row.status === 'active' ? row.next_on ?? null : null,
    next_run_at: row.status === 'active' ? row.next_run_at ?? null : null,
    upcoming,
    last_run_at: row.last_run_at ?? null,
    last_outcome: row.last_outcome ?? null,
    last_reason: row.last_reason ?? null,
    run_as: row.run_as ?? null,
    run_as_name: row.run_as ? maps.names.get(row.run_as) ?? null : null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    can_edit: canEdit,
  };
}

async function namesFor(service: SupabaseClient, rows: Row[]) {
  const templateIds = [...new Set(rows.map((r) => r.template_id).filter(Boolean))] as string[];
  const taskIds = [...new Set(rows.map((r) => r.task_id).filter(Boolean))] as string[];
  // includes-deleted: a schedule names its template and task even in Trash (it pauses, saying why)
  const [projects, names, templates, tasks] = await Promise.all([
    projectNames(service, rows.map((r) => r.project_id)),
    memberNames(service, rows.map((r) => r.run_as)),
    // includes-deleted: names only
    templateIds.length ? service.from('task_templates').select('id, name, project_id, deleted_at').in('id', templateIds) : Promise.resolve({ data: [], error: null }),
    // includes-deleted: names only
    taskIds.length ? service.from('tasks').select('id, title').in('id', taskIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const templateRows = (templates.data ?? []) as Row[];
  return {
    projects,
    names,
    templates: new Map(templateRows.map((t) => [t.id as string, t.name as string])),
    templateProjects: new Map(templateRows.map((t) => [t.id as string, (t.project_id as string | null) ?? null])),
    trashedTemplates: new Set(templateRows.filter((t) => !!t.deleted_at).map((t) => t.id as string)),
    tasks: new Map(((tasks.data ?? []) as Row[]).map((t) => [t.id as string, t.title as string])),
  };
}

/** Which of these tasks the caller is on (or on their parent), for tasks.manage_assigned. */
async function assignedTaskIds(service: SupabaseClient, memberId: string, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  const { data, error } = await service.from('task_assignees').select('task_id').eq('member_id', memberId).in('task_id', taskIds);
  if (error) throw error;
  return new Set(((data ?? []) as Row[]).map((r) => r.task_id as string));
}

function canEditRow(caller: AgentCaller, row: Row, templateProject: string | null | undefined, assigned: Set<string>): boolean {
  if (!reaches(caller, row.project_id) || !canRunTemplates(caller)) return false;
  if (row.kind === 'template') return row.run_as === caller.memberId || row.created_by === caller.memberId || canWriteTemplate(caller, templateProject ?? null);
  return callerHolds(caller, 'tasks.manage_all') || (callerHolds(caller, 'tasks.manage_assigned') && assigned.has(row.task_id));
}

async function presentRows(service: SupabaseClient, caller: AgentCaller, rows: Row[]): Promise<ScheduleView[]> {
  rows = rows.map(normalize);
  const maps = await namesFor(service, rows);
  const assigned = await assignedTaskIds(service, caller.memberId, rows.filter((r) => r.kind === 'task').map((r) => r.task_id));
  return rows.map((row) => present(row, maps, canEditRow(caller, row, row.template_id ? maps.templateProjects.get(row.template_id) : null, assigned)));
}

// ── Reading ─────────────────────────────────────────────────────────────

const readsTemplates = (caller: AgentCaller) => canRunTemplates(caller) || canManageTemplates(caller);
const readsTasks = (caller: AgentCaller) => callerHolds(caller, 'tasks.read') || callerHolds(caller, 'tasks.read_assigned');

/**
 * The tasks among these the caller may read, as the task reads decide:
 * every one with tasks.read; with tasks.read_assigned alone, those they made
 * or are assigned to (or with such a subtask); none otherwise. A task
 * repeat is shown only with its task.
 */
async function readableTasks(service: SupabaseClient, caller: AgentCaller, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  if (callerHolds(caller, 'tasks.read')) return new Set(ids);
  if (!callerHolds(caller, 'tasks.read_assigned')) return new Set();
  const me = caller.memberId;
  // includes-deleted: who made the series' task decides who reads its repeat, in Trash too
  const [{ data: tops, error: topsError }, { data: kids, error: kidsError }] = await Promise.all([
    service.from('tasks').select('id, created_by').in('id', ids),
    service.from('tasks').select('id, parent_task_id, created_by').in('parent_task_id', ids).is('deleted_at', null),
  ]);
  if (topsError) throw topsError;
  if (kidsError) throw kidsError;
  const children = (kids ?? []) as Row[];
  const assigned = await assignedTaskIds(service, me, [...ids, ...children.map((c) => c.id as string)]);
  const viaChild = new Set(children.filter((c) => c.created_by === me || assigned.has(c.id)).map((c) => c.parent_task_id as string));
  return new Set(((tops ?? []) as Row[]).filter((t) => t.created_by === me || assigned.has(t.id) || viaChild.has(t.id)).map((t) => t.id as string));
}

export interface ScheduleFilters {
  kind?: ScheduleKind | null;
  template_id?: string | null;
  task_id?: string | null;
  project_id?: string | null;
  status?: ScheduleStatus | null;
  offset: number;
  limit: number;
}

export function scheduleFiltersFrom(params: URLSearchParams): Omit<ScheduleFilters, 'offset' | 'limit'> {
  const kind = params.get('kind');
  const status = params.get('status');
  const uuid = (key: string) => {
    const value = params.get(key);
    if (value && !UUID.test(value)) throw badRequest(`${key} must be a uuid`);
    return value || null;
  };
  if (kind && kind !== 'template' && kind !== 'task') throw badRequest('kind is template or task');
  if (status && !['active', 'paused', 'ended'].includes(status)) throw badRequest('status is active, paused or ended');
  return { kind: kind as ScheduleKind | null, status: status as ScheduleStatus | null, template_id: uuid('template_id'), task_id: uuid('task_id'), project_id: uuid('project_id') };
}

/** Schedules on projects the caller can open, soonest next first, paged. */
export async function listSchedules(service: SupabaseClient, caller: AgentCaller, filters: ScheduleFilters): Promise<{ rows: ScheduleView[]; total: number }> {
  const kinds = (['template', 'task'] as const).filter((k) => (k === 'template' ? readsTemplates(caller) : readsTasks(caller)) && (!filters.kind || filters.kind === k));
  if (!kinds.length) return { rows: [], total: 0 };
  let query = service.from('schedules').select(COLUMNS, { count: 'exact' }).is('deleted_at', null).in('kind', kinds);
  if (filters.template_id) query = query.eq('template_id', filters.template_id);
  if (filters.task_id) query = query.eq('task_id', filters.task_id);
  if (filters.project_id) query = query.eq('project_id', filters.project_id);
  if (filters.status) {
    // By the status it reads: an active schedule whose template is in Trash reads paused (present).
    // includes-deleted: the templates in Trash, to sort their schedules into paused
    const { data: trashed, error: trashedError } = await service.from('task_templates').select('id').not('deleted_at', 'is', null);
    if (trashedError) fail(trashedError);
    const gone = ((trashed ?? []) as Row[]).map((t) => t.id as string).filter((tid) => UUID.test(tid));
    if (!gone.length || filters.status === 'ended') query = query.eq('status', filters.status);
    else if (filters.status === 'active') query = query.eq('status', 'active').or(`template_id.is.null,template_id.not.in.(${gone.join(',')})`);
    else query = query.or(`status.eq.paused,and(status.eq.active,template_id.in.(${gone.join(',')}))`);
  }
  if (!callerHolds(caller, 'projects.read_all')) {
    const reachable = caller.access.project_ids.filter((id) => UUID.test(id) && reaches(caller, id));
    if (!reachable.length) return { rows: [], total: 0 };
    query = query.in('project_id', reachable);
  }
  const { data, count, error } = await readPage(query.order('next_run_at', { ascending: true, nullsFirst: false }).order('created_at').order('id'), filters);
  if (error) fail(error);
  const reached = ((data ?? []) as Row[]).filter((row) => reaches(caller, row.project_id));
  const readable = await readableTasks(service, caller, reached.filter((row) => row.kind === 'task').map((row) => row.task_id as string));
  const rows = reached.filter((row) => row.kind !== 'task' || readable.has(row.task_id));
  return { rows: await presentRows(service, caller, rows), total: Math.max(rows.length, (count ?? reached.length) - (reached.length - rows.length)) };
}

async function loadRow(service: SupabaseClient, caller: AgentCaller, id: string): Promise<Row> {
  if (!UUID.test(id)) throw notFound('Schedule');
  const { data, error } = await service.from('schedules').select(COLUMNS).eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  const row = data ? normalize(data as Row) : null;
  if (!row || !reaches(caller, row.project_id) || !(row.kind === 'template' ? readsTemplates(caller) : readsTasks(caller))) throw notFound('Schedule');
  if (row.kind === 'task' && !(await readableTasks(service, caller, [row.task_id])).has(row.task_id)) throw notFound('Schedule');
  return row;
}

export async function getSchedule(service: SupabaseClient, caller: AgentCaller, id: string): Promise<ScheduleView> {
  return (await presentRows(service, caller, [await loadRow(service, caller, id)]))[0];
}

function presentOccurrence(row: Row): ScheduleOccurrenceView {
  return {
    id: row.id, schedule_id: row.schedule_id, scheduled_for: day(row.scheduled_for) as string, status: row.status, reason: row.reason ?? null,
    error: row.error ?? null, attempts: row.attempts, run_id: row.run_id ?? null, task_id: row.task_id ?? null,
    started_at: row.started_at, finished_at: row.finished_at ?? null,
  };
}

/** What a schedule made, skipped or failed, newest first, paged. */
export async function listOccurrences(service: SupabaseClient, caller: AgentCaller, id: string, page: { offset: number; limit: number }): Promise<{ rows: ScheduleOccurrenceView[]; total: number }> {
  await loadRow(service, caller, id);
  const { data, count, error } = await readPage(service.from('schedule_occurrences').select(OCCURRENCE_COLUMNS, { count: 'exact' })
    .eq('schedule_id', id).order('scheduled_for', { ascending: false }).order('id'), page);
  if (error) fail(error);
  return { rows: ((data ?? []) as Row[]).map(presentOccurrence), total: count ?? 0 };
}

// ── Template schedules ──────────────────────────────────────────────────

/** What a template run on `date` takes: key dates from the date and offsets, stored values plus date and month, the role map. */
export function runInputFor(row: Row, template: { key_dates: TemplateKeyDate[]; fields: TemplateField[] }, date: string): RunTaskTemplateInput {
  const offsets = objectOf<number>(row.key_date_offsets);
  const fills = scheduleFills(date);
  const values: Record<string, string> = { ...objectOf<string>(row.field_values) };
  for (const field of template.fields) {
    if (field.key === 'date' || field.key === 'month') values[field.key] = fills[field.key];
  }
  return {
    project_id: row.project_id,
    key_dates: Object.fromEntries(keyDatesOf(template.key_dates).map((k) => [k.key, addDays(date, offsets[k.key] ?? 0)])),
    values,
    roles: objectOf<string | null>(row.role_members) as RunTaskTemplateInput['roles'],
    ...(row.create_initiative ? { create_initiative: true } : {}),
  };
}

const templateShape = (template: Row) => ({
  key_dates: keyDatesOf(Array.isArray(template.key_dates) ? template.key_dates : null),
  fields: (Array.isArray(template.fields) ? template.fields : []) as TemplateField[],
});

/** A template schedule checked like a run on its first date: every error with its path, as preview shows them. */
async function checkTemplateSchedule(service: SupabaseClient, caller: AgentCaller, template: Row, row: Row, firstDate: string): Promise<void> {
  const shape = templateShape(template);
  const known = new Set(shape.key_dates.map((k) => k.key));
  const bad = Object.keys(objectOf(row.key_date_offsets)).filter((key) => !known.has(key));
  const prepared = await prepareRun(service, caller, template.id, runInputFor(row, shape, firstDate));
  const errors = [
    ...bad.map((key) => templateIssue(['key_date_offsets', key], 'unknown_key_date', `"${key}" is not one of this template's key dates`, `Use: ${[...known].join(', ')}.`)),
    ...prepared.errors,
  ];
  if (errors.length) throw templateErrors(errors, errors[0].code === 'cannot_assign_others' ? 403 : 422);
}

function checkDates(start: string, end: string | null | undefined) {
  if (end && end < start) throw unprocessable('The end date is before the start date', 'end_date', 'invalid_date', 'Pick an end date on or after the start date, or none.');
}

/** Sets up a template schedule: checked like a run for its first date. Answers the schedule. */
export async function createTemplateSchedule(service: SupabaseClient, caller: AgentCaller, templateId: string, input: TemplateScheduleInput, now = new Date()): Promise<ScheduleView> {
  const template = await loadTemplateRow(service, caller, templateId);
  if (!canRunTemplates(caller)) {
    throw forbidden('A schedule uses the template, which creates tasks: that needs tasks.create', { reason: 'missing_permission', needs: 'tasks.create', hint: 'Ask an Owner to grant you Create tasks.' });
  }
  const projectId = (template.project_id as string | null) ?? input.project_id ?? null;
  if (template.project_id && input.project_id && input.project_id !== template.project_id) {
    throw unprocessable('This template belongs to another project and always runs there', 'project_id', 'locked_to_project', 'Leave project_id out, or use the template\'s own project.');
  }
  if (!projectId) throw unprocessable('Pick the project the runs go in', 'project_id', 'project_required', 'Send project_id: a project you can open.');
  const zone = input.timezone ?? await workspaceZone(service);
  const start = input.start_date ?? todayIn(zone, now);
  checkDates(start, input.end_date);
  const rule = recurrenceSchema.parse(input.recurrence);
  const state = initialState({ kind: 'template', mode: 'schedule', rule, start, end: input.end_date ?? null, zone }, now);
  const row: Row = {
    kind: 'template', template_id: templateId, project_id: projectId, recurrence: rule, timezone: zone, start_date: start, end_date: input.end_date ?? null,
    mode: 'schedule', role_members: input.roles ?? {}, field_values: input.values ?? {}, key_date_offsets: input.key_date_offsets ?? {},
    create_initiative: input.create_initiative ?? false, skip_if_open: input.skip_if_open ?? true,
    ...state, run_as: caller.memberId, created_by: caller.memberId, updated_by: caller.memberId,
  };
  await checkTemplateSchedule(service, caller, template, row, state.next_on ?? start);
  const { data, error } = await service.from('schedules').insert(row).select(COLUMNS).single();
  if (error) fail(error);
  await ensureSchedulerSecret(service);
  return (await presentRows(service, caller, [data as Row]))[0];
}

// ── Task repeats ────────────────────────────────────────────────────────

async function loadTask(service: SupabaseClient, taskId: string): Promise<Row | null> {
  if (!UUID.test(taskId)) return null;
  const { data, error } = await service.from('tasks')
    .select('id, project_id, parent_task_id, title, description, status, priority, tags, due_date, initiative_id, project_goal_id, deleted_at, project:projects!inner(id, deleted_at)')
    .eq('id', taskId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  if (!row || row.project?.deleted_at) return null;
  return normalizeTask(row);
}

/** Whether the caller may edit this task: tasks.manage_all, or tasks.manage_assigned on a task they (or its parent) are on. */
async function mayEditTask(service: SupabaseClient, caller: AgentCaller, task: Row): Promise<boolean> {
  if (callerHolds(caller, 'tasks.manage_all')) return true;
  if (!callerHolds(caller, 'tasks.manage_assigned')) return false;
  return (await assignedTaskIds(service, caller.memberId, [task.id, task.parent_task_id].filter(Boolean))).size > 0;
}

async function taskForRepeat(service: SupabaseClient, caller: AgentCaller, taskId: string): Promise<Row> {
  const task = await loadTask(service, taskId);
  if (!task || !reaches(caller, task.project_id)) throw new ApiError(404, 'NOT_FOUND', 'Task not found. It may be in Trash.', { reason: 'not_found_or_in_trash', resource: 'task' });
  return task;
}

async function requireTaskRepeatRights(service: SupabaseClient, caller: AgentCaller, task: Row): Promise<void> {
  if (!(await mayEditTask(service, caller, task))) {
    throw forbidden('You cannot change this task', { reason: 'cannot_edit_task', hint: 'A repeat is set by whoever may edit the task: tasks.manage_all, or tasks.manage_assigned on a task you are on.' });
  }
  if (!canRunTemplates(caller)) {
    throw forbidden('A repeat creates tasks, which needs tasks.create', { reason: 'missing_permission', needs: 'tasks.create', hint: 'Ask an Owner to grant you Create tasks.' });
  }
}

async function repeatRow(service: SupabaseClient, taskId: string): Promise<Row | null> {
  const { data, error } = await service.from('schedules').select(COLUMNS).eq('kind', 'task').eq('task_id', taskId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  return data ? normalize(data as Row) : null;
}

/** A task's repeat, or null. */
export async function getTaskRepeat(service: SupabaseClient, caller: AgentCaller, taskId: string): Promise<ScheduleView | null> {
  await taskForRepeat(service, caller, taskId);
  if (!(await readableTasks(service, caller, [taskId])).has(taskId)) throw new ApiError(404, 'NOT_FOUND', 'Task not found. It may be in Trash.', { reason: 'not_found_or_in_trash', resource: 'task' });
  const row = await repeatRow(service, taskId);
  return row ? (await presentRows(service, caller, [row]))[0] : null;
}

/**
 * Sets (or replaces) a task's repeat. Its copies are due on the
 * recurrence's dates counted from the task's due date; a task without one
 * gets the first date on or after today as its due date. Answers the
 * schedule and, when it set one, the task's new due date.
 */
export async function setTaskRepeat(service: SupabaseClient, caller: AgentCaller, taskId: string, input: TaskRepeatInput, now = new Date()): Promise<{ repeat: ScheduleView; due_date: string; due_date_set: boolean }> {
  const task = await taskForRepeat(service, caller, taskId);
  if (task.parent_task_id) throw badRequest('Only a top-level task repeats. A subtask is copied with its parent.', { reason: 'subtask_cannot_repeat' });
  await requireTaskRepeatRights(service, caller, task);
  const existing = await repeatRow(service, taskId);
  const zone = input.timezone ?? existing?.timezone ?? await workspaceZone(service);
  const rule = recurrenceSchema.parse(input.recurrence);
  const today = todayIn(zone, now);
  const dueSet = !task.due_date;
  // A due date saved before dates were checked (text column) counts by its day (an ISO date-time gives its date); one that is no date is a 422, never a 500.
  const storedDue = task.due_date ? apiDateOf(String(task.due_date)) : null;
  if (task.due_date && !storedDue) {
    throw new ApiError(422, 'VALIDATION_ERROR', `The task's due date ${String(task.due_date)} is not a real date. Change it, then set the repeat.`, { reason: 'invalid_due_date', field: 'due_date' });
  }
  const due = storedDue ?? nextOnOrAfter(rule, today, today);
  if (!inScheduleRange(due)) {
    throw unprocessable(`A repeat counts from the task's due date, ${due}, which is outside 2000 to 2099`, 'due_date', 'invalid_date', 'Give the task a due date from 2000 to 2099 first.');
  }
  checkDates(due, input.end_date);
  const mode = input.mode ?? 'schedule';
  const state = initialState({ kind: 'task', mode, rule, start: due, end: input.end_date ?? null, zone, sourceDue: due, sourceDone: task.status === 'done' }, now);
  const fields: Row = {
    recurrence: rule, timezone: zone, start_date: due, end_date: input.end_date ?? null, mode, project_id: task.project_id,
    ...state, paused_reason: null, run_as: caller.memberId, updated_by: caller.memberId, updated_at: new Date().toISOString(),
  };
  let saved: Row;
  if (existing) {
    const { data, error } = await service.from('schedules').update(fields).eq('id', existing.id).select(COLUMNS).single();
    if (error) fail(error);
    saved = data as Row;
  } else {
    const { data, error } = await service.from('schedules').insert({ ...fields, kind: 'task', task_id: taskId, created_by: caller.memberId }).select(COLUMNS).single();
    if (error) {
      if (error.code === '23505') throw new ApiError(409, 'CONFLICT', 'Someone set a repeat on this task at the same moment. Read it again.', { reason: 'repeat_exists' });
      fail(error);
    }
    saved = data as Row;
  }
  // Only once the repeat is saved: a request refused above (409) changes nothing.
  // A due date someone set meanwhile stays.
  if (dueSet) {
    const { error } = await service.from('tasks').update({ due_date: due }).eq('id', taskId).is('deleted_at', null).is('due_date', null);
    if (error) throw error;
  }
  await ensureSchedulerSecret(service);
  return { repeat: (await presentRows(service, caller, [saved]))[0], due_date: due, due_date_set: dueSet };
}

/** Stops a task repeating. Copies already made stay. */
export async function clearTaskRepeat(service: SupabaseClient, caller: AgentCaller, taskId: string): Promise<{ removed: boolean }> {
  const task = await taskForRepeat(service, caller, taskId);
  await requireTaskRepeatRights(service, caller, task);
  const existing = await repeatRow(service, taskId);
  if (!existing) return { removed: false };
  const { error } = await service.from('schedules').update({ deleted_at: new Date().toISOString(), deleted_by: caller.memberId }).eq('id', existing.id).is('deleted_at', null);
  if (error) fail(error);
  return { removed: true };
}

// ── Changing and removing ───────────────────────────────────────────────

async function requireEdit(service: SupabaseClient, caller: AgentCaller, row: Row): Promise<void> {
  if (row.kind === 'task') {
    const task = await loadTask(service, row.task_id);
    if (task) return requireTaskRepeatRights(service, caller, task);
    if (!callerHolds(caller, 'tasks.manage_all')) throw forbidden('Only tasks.manage_all changes a repeat whose task is in Trash', { reason: 'cannot_edit_task' });
    return;
  }
  // includes-deleted: who may change a schedule follows its template's scope, in Trash too
  const { data } = await service.from('task_templates').select('project_id').eq('id', row.template_id).maybeSingle();
  const templateProject = (data as Row | null)?.project_id ?? null;
  if (!canEditRow(caller, row, templateProject, new Set())) {
    throw forbidden('Only whoever set this schedule up, or may change its template, changes it', {
      reason: 'cannot_edit_schedule', needs: ['tasks.create', 'templates.manage'], hint: 'Ask whoever set it up, or someone who manages templates.',
    });
  }
}

/**
 * Changes a schedule: only what is sent. status paused pauses it; active
 * resumes it from today (missed dates are not made). A change to what it
 * makes is checked like a run for its next date, and makes the caller its
 * runner.
 */
export async function updateSchedule(service: SupabaseClient, caller: AgentCaller, id: string, input: ScheduleUpdateInput, now = new Date()): Promise<ScheduleView> {
  const row = await loadRow(service, caller, id);
  await requireEdit(service, caller, row);
  if (row.kind === 'task' && (input.project_id || input.roles || input.values || input.key_date_offsets || input.create_initiative !== undefined || input.skip_if_open !== undefined || input.start_date)) {
    throw badRequest('A task repeat takes recurrence, mode, timezone, end_date and status only', { reason: 'not_for_task_repeat' });
  }
  if (row.kind === 'template' && input.mode && input.mode !== 'schedule') {
    throw badRequest('A template schedule runs on its dates; after_done is for a task repeat', { reason: 'not_for_template_schedule' });
  }
  const content = ['project_id', 'recurrence', 'roles', 'values', 'key_date_offsets', 'create_initiative', 'start_date', 'mode'].some((key) => (input as Row)[key] !== undefined);
  const timing = content || input.timezone !== undefined || input.end_date !== undefined || input.status === 'active';
  const next: Row = { ...row };
  if (input.project_id !== undefined) next.project_id = input.project_id;
  if (input.recurrence) next.recurrence = recurrenceSchema.parse(input.recurrence);
  if (input.timezone) next.timezone = input.timezone;
  if (input.start_date) next.start_date = input.start_date;
  if (input.end_date !== undefined) next.end_date = input.end_date;
  if (input.roles) next.role_members = input.roles;
  if (input.values) next.field_values = input.values;
  if (input.key_date_offsets) next.key_date_offsets = input.key_date_offsets;
  if (input.create_initiative !== undefined) next.create_initiative = input.create_initiative;
  if (input.skip_if_open !== undefined) next.skip_if_open = input.skip_if_open;
  if (input.mode) next.mode = input.mode;

  let task: Row | null = null;
  if (row.kind === 'task') {
    task = await loadTask(service, row.task_id);
    if (input.recurrence && task?.due_date) next.start_date = task.due_date;
  }
  checkDates(next.start_date, next.end_date);

  if (input.status === 'paused') {
    next.status = 'paused';
    next.paused_reason = null;
  } else if (timing && (next.status !== 'paused' || input.status === 'active')) {
    const state = initialState({
      kind: next.kind, mode: next.mode, rule: next.recurrence, start: next.start_date, end: next.end_date ?? null, zone: next.timezone,
      sourceDue: task?.due_date ?? null, sourceDone: task?.status === 'done',
    }, now);
    Object.assign(next, state, { paused_reason: null });
    if (next.kind === 'template') Object.assign(next, await pastMadeDates(service, next, id));
  }
  if (row.kind === 'template' && (content || input.status === 'active')) {
    if (input.status === 'active') {
      // includes-deleted: a schedule whose template is in Trash says so, rather than "not found"
      const { data: tpl } = await service.from('task_templates').select('deleted_at').eq('id', row.template_id).maybeSingle();
      if ((tpl as Row | null)?.deleted_at) {
        throw new ApiError(409, 'CONFLICT', 'The template is in Trash, so this schedule cannot run. Restore the template, then resume it.', { reason: 'template_in_trash' });
      }
    }
    const template = await loadTemplateRow(service, caller, row.template_id);
    if (template.project_id && next.project_id !== template.project_id) {
      throw unprocessable('This template belongs to another project and always runs there', 'project_id', 'locked_to_project', 'Leave project_id out, or use the template\'s own project.');
    }
    await checkTemplateSchedule(service, caller, template, next, next.next_on ?? todayIn(next.timezone, now));
  }
  const changes: Row = {
    project_id: next.project_id, recurrence: next.recurrence, timezone: next.timezone, start_date: next.start_date, end_date: next.end_date ?? null,
    role_members: next.role_members, field_values: next.field_values, key_date_offsets: next.key_date_offsets, create_initiative: next.create_initiative,
    skip_if_open: next.skip_if_open, mode: next.mode, status: next.status, paused_reason: next.paused_reason ?? null, next_on: next.next_on ?? null,
    next_run_at: next.next_run_at ?? null, done_on: next.done_on ?? null, updated_by: caller.memberId, updated_at: new Date().toISOString(),
    ...(content ? { run_as: caller.memberId } : {}),
  };
  const { data, error } = await service.from('schedules').update(changes).eq('id', id).is('deleted_at', null).select(COLUMNS).single();
  if (error) fail(error);
  return (await presentRows(service, caller, [data as Row]))[0];
}

/** Removes a schedule: it never runs again. What it made stays. */
export async function deleteSchedule(service: SupabaseClient, caller: AgentCaller, id: string): Promise<ScheduleView> {
  const row = await loadRow(service, caller, id);
  await requireEdit(service, caller, row);
  const { data, error } = await service.from('schedules').update({ deleted_at: new Date().toISOString(), deleted_by: caller.memberId }).eq('id', id).select(COLUMNS).single();
  if (error) fail(error);
  return (await presentRows(service, caller, [data as Row]))[0];
}

// ── The engine ──────────────────────────────────────────────────────────

export interface ScheduleRunSummary {
  due: number;
  created: number;
  skipped: number;
  failed: number;
  retried: number;
  paused: number;
  ended: number;
}

type Outcome =
  | { status: 'created'; run_id?: string; task_id?: string }
  | { status: 'skipped'; reason: string; pause: boolean };

/** The runner's own rights at run time: a person on the app channel, an agent on the API with everything it holds there. */
async function runnerCaller(service: SupabaseClient, memberId: string | null): Promise<AgentCaller | null> {
  if (!memberId) return null;
  const access = await resolveMemberAccess(service, memberId);
  if (!access || access.status !== 'active') return null;
  return access.role === 'agent' ? { memberId, access, scopes: apiScopesFor(access) } : { memberId, access, scopes: null };
}

/** Whether an agent runner is paused: every agent (the workspace switch), itself, or on this project. */
async function agentPaused(service: SupabaseClient, memberId: string, projectId: string): Promise<boolean> {
  const [{ data: me, error: meError }, { data: settings }, { data: onProject }] = await Promise.all([
    service.from('team_members').select('agent_paused_at').eq('id', memberId).maybeSingle(),
    service.from('business_settings').select('agents_paused_at').limit(1).maybeSingle(),
    service.from('project_agents').select('status').eq('agent_id', memberId).eq('project_id', projectId).maybeSingle(),
  ]);
  if (meError) throw meError;
  return !!(me as Row | null)?.agent_paused_at || !!(settings as Row | null)?.agents_paused_at || (onProject as Row | null)?.status === 'paused';
}

/** A personal agent creates tasks only while its person leaves "create tasks" on (requireAssistantSwitch, as for its own requests). */
async function assistantMayCreate(service: SupabaseClient, caller: AgentCaller): Promise<boolean> {
  const { data } = await service.from('team_members').select('delegate_of').eq('id', caller.memberId).maybeSingle();
  const person = (data as Row | null)?.delegate_of as string | null | undefined;
  if (!person) return true;
  try {
    await requireAssistantSwitch(service, caller.memberId, { ...caller.access, principal_id: person }, 'create_tasks');
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.details as Row | undefined)?.reason === 'assistant_switch_off') return false;
    throw error;
  }
}

const errorText = (error: unknown) => {
  if (error instanceof ApiError) {
    const issues = (error.details as { errors?: { path?: string; message?: string }[] } | undefined)?.errors;
    return issues?.length ? `${error.message}: ${issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join('; ')}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Who hears that a schedule paused itself: the people who can fix it. Its
 * runner and whoever set it up, when they are active people; for an agent
 * among them, the people who manage it (its owners, owner groups or person,
 * else the Owners: pm.agent_people_to_tell, as the watchdog tells them).
 * Nobody left (a suspended person ran it alone): the Owners.
 */
async function peopleToTellAboutSchedule(service: SupabaseClient, row: Row): Promise<string[]> {
  const ids = [...new Set([row.run_as, row.created_by].filter(Boolean))] as string[];
  if (!ids.length) return [];
  const { data, error } = await service.from('team_members').select('id, role, status').in('id', ids);
  if (error) throw error;
  const people = new Set<string>();
  for (const member of (data ?? []) as Row[]) {
    if (member.role === 'agent') {
      const { data: managers, error: managersError } = await service.rpc('agent_people_to_tell', { p_agent_id: member.id });
      if (managersError) throw managersError;
      for (const managerId of (managers ?? []) as string[]) people.add(managerId);
    } else if ((member.status ?? 'active') === 'active') {
      people.add(member.id as string);
    }
  }
  if (!people.size) {
    const { data: owners, error: ownersError } = await service.from('team_members').select('id, status').eq('role', 'owner');
    if (ownersError) throw ownersError;
    for (const owner of (owners ?? []) as Row[]) if ((owner.status ?? 'active') === 'active') people.add(owner.id as string);
  }
  return [...people];
}

async function notifyPaused(service: SupabaseClient, row: Row, reason: string): Promise<void> {
  let people: string[];
  try {
    people = await peopleToTellAboutSchedule(service, row);
  } catch (error) {
    console.error('[schedules] could not work out who to tell about a paused schedule', row.id, error);
    return;
  }
  if (!people.length) return;
  const why = OCCURRENCE_REASON_WORDS[reason] ?? reason;
  let what = 'A schedule';
  let link = '/settings/templates';
  if (row.kind === 'template') {
    // includes-deleted: the notice names the template even when it went to Trash
    const { data } = await service.from('task_templates').select('name').eq('id', row.template_id).maybeSingle();
    what = `The schedule for "${(data as Row | null)?.name ?? 'a template'}"`;
    link = `/settings/templates?schedule=${row.id}`;
  } else {
    // includes-deleted: the notice names the task even when it went to Trash
    const { data } = await service.from('tasks').select('title').eq('id', row.task_id).maybeSingle();
    what = `The repeat on "${(data as Row | null)?.title ?? 'a task'}"`;
    link = `/projects/${row.project_id}?task=${row.task_id}`;
  }
  await Promise.all(people.map(async (to) => {
    const { error } = await service.rpc('upsert_notification', {
      p_user_id: to, p_title: 'A schedule paused', p_message: `${what} paused: ${why}. Open it to fix it and resume.`.slice(0, 500),
      p_link: link, p_entity_type: 'schedule', p_entity_id: row.id,
    });
    if (error) console.error('[schedules] could not notify about a paused schedule', row.id, error);
  }));
}

/** Makes the next copy of a task, due on `dueOn`: same title, description, people, initiative, tags and priority; subtasks unchecked, their dates shifted alike. */
async function copyTask(service: SupabaseClient, caller: AgentCaller, source: Row, dueOn: string): Promise<string> {
  const [{ data: subs, error: subsError }, { data: people, error: peopleError }] = await Promise.all([
    service.from('tasks').select('id, title, description, priority, tags, due_date, sort_order').eq('parent_task_id', source.id).is('deleted_at', null).order('sort_order'),
    service.from('task_assignees').select('task_id, member_id').eq('task_id', source.id),
  ]);
  if (subsError) throw subsError;
  if (peopleError) throw peopleError;
  const subtasks = ((subs ?? []) as Row[]).map(normalizeTask);
  const { data: subPeople, error: subPeopleError } = subtasks.length
    ? await service.from('task_assignees').select('task_id, member_id').in('task_id', subtasks.map((s) => s.id))
    : { data: [], error: null };
  if (subPeopleError) throw subPeopleError;
  const assignments = [...((people ?? []) as Row[]), ...((subPeople ?? []) as Row[])];
  const ids = [...new Set(assignments.map((a) => a.member_id as string))];
  const reach = await Promise.all(ids.map(async (memberId) => {
    const access = await resolveMemberAccess(service, memberId);
    return !!access && access.status === 'active' && (accessAllowsProject(access, source.project_id, 'app') || accessAllowsProject(access, source.project_id, 'api'));
  }));
  const allowed = new Set(ids.filter((_, i) => reach[i]));
  // An agent whoever runs the repeat may no longer give work to (its orchestrator, who can use it, ask first)
  // stays off the copy, and its managers are told: a repeat never feeds an agent that was narrowed.
  const giver = workGiverOf(caller.access, caller.memberId);
  const refusedAgents: string[] = [];
  for (const agentId of await agentIdsAmong(service, [...allowed])) {
    if (!(await mayGiveAgentWork(service, agentId, giver))) {
      allowed.delete(agentId);
      refusedAgents.push(agentId);
    }
  }
  const peopleOf = (taskId: string) => assignments.filter((a) => a.task_id === taskId && allowed.has(a.member_id)).map((a) => a.member_id as string);
  const delta = source.due_date ? daysBetween(source.due_date, dueOn) : 0;
  const note = `Repeats from "${source.title}"`.slice(0, 200);
  const base = (task: Row) => ({
    project_id: source.project_id, title: task.title, description: task.description ?? '', status: 'todo', priority: task.priority, tags: task.tags ?? [],
    created_by: caller.memberId, created_note: note,
  });
  const parent = await insertTask(service, {
    ...base(source), due_date: dueOn,
    ...(source.initiative_id ? { initiative_id: source.initiative_id } : {}),
    ...(source.project_goal_id ? { project_goal_id: source.project_goal_id } : {}),
  } as unknown as Parameters<typeof insertTask>[1], peopleOf(source.id));
  try {
    for (let start = 0; start < subtasks.length; start += SUBTASK_BATCH) {
      await Promise.all(subtasks.slice(start, start + SUBTASK_BATCH).map((sub) => insertTask(service, {
        ...base(sub), due_date: sub.due_date ? addDays(sub.due_date, delta) : null, parent_task_id: parent.id, sort_order: sub.sort_order,
      } as unknown as Parameters<typeof insertTask>[1], peopleOf(sub.id)).catch((error: unknown) => { throw subtaskRuleError(error); })));
    }
  } catch (error) {
    // Nothing half made: the copy (its subtasks go with it) goes to Trash.
    await moveToTrash(service, 'tasks', parent.id, caller.memberId).catch((trashError: unknown) => {
      console.error('[schedules] could not move a partly made copy to Trash', parent.id, trashError);
    });
    throw error;
  }
  for (const agentId of refusedAgents) {
    const { data: agent } = await service.from('team_members').select('name').eq('id', agentId).maybeSingle();
    await notifyAgentManagers(service, agentId, {
      title: 'A repeat was left unassigned',
      message: `The next "${source.title}" was made without ${(agent as Row | null)?.name ?? 'its agent'}: whoever runs the repeat can no longer give it work. Assign it, or change who can use the agent.`,
      link: `/projects/${source.project_id}?task=${parent.id}`,
      entityType: 'task',
      entityId: parent.id as string,
    });
  }
  return parent.id as string;
}

/** Works one claimed occurrence: checks, then runs the template or copies the task. */
async function attempt(service: SupabaseClient, row: Row, scheduledFor: string, sourceTaskId: string | null): Promise<Outcome> {
  const caller = await runnerCaller(service, row.run_as ?? row.created_by);
  if (!caller) return { status: 'skipped', reason: 'lost_access', pause: true };
  const { data: project } = await service.from('projects').select('id').eq('id', row.project_id).is('deleted_at', null).maybeSingle();
  if (!project) return { status: 'skipped', reason: 'project_gone', pause: true };
  if (!reaches(caller, row.project_id) || !canRunTemplates(caller)) return { status: 'skipped', reason: 'lost_access', pause: true };
  const member = await loadMemberRules(service, caller.memberId);
  if (member.isAgent && member.rules.agent_create_policy === 'approval') return { status: 'skipped', reason: 'needs_approval', pause: true };
  if (caller.access.role === 'agent') {
    // What the API's request gate refuses an agent: the workspace switch, its own pause, a pause on this project.
    if (await agentPaused(service, caller.memberId, row.project_id)) return { status: 'skipped', reason: 'runner_paused', pause: true };
    // A personal agent's person may have turned off "create tasks" for it.
    if (!(await assistantMayCreate(service, caller))) return { status: 'skipped', reason: 'assistant_switch_off', pause: true };
  }

  if (row.kind === 'template') {
    const { data: template } = await service.from('task_templates').select('id, project_id, key_dates, fields').eq('id', row.template_id).is('deleted_at', null).maybeSingle();
    if (!template) return { status: 'skipped', reason: 'template_gone', pause: true };
    const tpl = template as Row;
    if (tpl.project_id && !reaches(caller, tpl.project_id)) return { status: 'skipped', reason: 'lost_access', pause: true };
    if (row.skip_if_open) {
      const { data: last } = await service.from('task_template_runs').select('id, task_ids').eq('schedule_id', row.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const taskIds = ((last as Row | null)?.task_ids ?? []) as string[];
      if (taskIds.length) {
        const { count } = await service.from('tasks').select('id', { count: 'exact', head: true }).in('id', taskIds).neq('status', 'done').is('deleted_at', null);
        if ((count ?? 0) > 0) return { status: 'skipped', reason: 'previous_run_open', pause: false };
      }
    }
    try {
      const result = await createTemplateRun(service, caller, row.template_id, runInputFor(row, templateShape(tpl), scheduledFor), 'schedule', { scheduleId: row.id });
      return { status: 'created', run_id: result.run.id };
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) return { status: 'skipped', reason: 'lost_access', pause: true };
      if (error instanceof ApiError && (error.details as Row | undefined)?.reason === 'project_scope') return { status: 'skipped', reason: 'lost_access', pause: true };
      throw error;
    }
  }

  const source = sourceTaskId ? await loadTask(service, sourceTaskId) : null;
  if (!source) return { status: 'skipped', reason: 'task_gone', pause: true };
  const taskId = await copyTask(service, caller, source, scheduledFor);
  // The series follows its newest copy; a copy made while someone changed the repeat still counts.
  const { error } = await service.from('schedules').update({ task_id: taskId, updated_at: new Date().toISOString() }).eq('id', row.id).eq('task_id', source.id);
  if (error) console.error('[schedules] could not move the repeat to its new copy', row.id, error);
  return { status: 'created', task_id: taskId };
}

/** Runs a claimed occurrence and records how it went. */
async function execute(service: SupabaseClient, row: Row, occurrenceId: string, scheduledFor: string, sourceTaskId: string | null, attempts: number, summary: ScheduleRunSummary): Promise<void> {
  const finished = new Date().toISOString();
  let outcome: Outcome | null = null;
  let failure: string | null = null;
  try {
    outcome = await attempt(service, row, scheduledFor, sourceTaskId);
  } catch (error) {
    failure = errorText(error).slice(0, 2000);
    console.error('[schedules] an occurrence failed', row.id, scheduledFor, error);
  }
  const status: OccurrenceStatus = outcome ? outcome.status : 'failed';
  const reason = outcome?.status === 'skipped' ? outcome.reason : null;
  await service.from('schedule_occurrences').update({
    status, reason, error: failure, finished_at: new Date().toISOString(),
    run_id: outcome?.status === 'created' ? outcome.run_id ?? null : null,
    task_id: outcome?.status === 'created' ? outcome.task_id ?? null : null,
  }).eq('id', occurrenceId);
  const pauseReason = outcome?.status === 'skipped' && outcome.pause ? outcome.reason : !outcome && attempts >= 2 ? 'failed_twice' : null;
  const changes: Row = { last_run_at: finished, last_outcome: status, last_reason: reason ?? (failure ? 'failed' : null), updated_at: finished };
  const { error } = await service.from('schedules').update(changes).eq('id', row.id);
  if (error) console.error('[schedules] could not record an outcome', row.id, error);
  if (pauseReason) {
    const { data: paused } = await service.from('schedules').update({ status: 'paused', paused_reason: pauseReason }).eq('id', row.id).eq('status', 'active').select('id');
    if (paused?.length) {
      summary.paused++;
      await notifyPaused(service, row, pauseReason);
    }
  }
  if (status === 'created') summary.created++;
  else if (status === 'skipped') summary.skipped++;
  else summary.failed++;
}

/** Ends a schedule whose next date is past its end date, making nothing. */
async function endSchedule(service: SupabaseClient, row: Row, summary: ScheduleRunSummary): Promise<void> {
  const { data } = await service.from('schedules').update({ status: 'ended', next_on: null, next_run_at: null, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'active').select('id');
  if (data?.length) summary.ended++;
}

/** Claims and runs one due schedule's occurrence. */
async function processDue(service: SupabaseClient, row: Row, now: Date, summary: ScheduleRunSummary): Promise<void> {
  const rule = row.recurrence as Recurrence;
  const zone = row.timezone as string;
  const today = todayIn(zone, now);
  const start = row.start_date as string;
  let scheduledFor: string;
  let nextOn: string | null = null;
  let nextRunAt: string | null = null;
  let status: ScheduleStatus = 'active';
  let sourceTaskId: string | null = null;

  if (row.kind === 'template') {
    const base = (row.next_on as string | null) ?? nextOnOrAfter(rule, start, today);
    const latest = lastOnOrBefore(rule, start, today);
    // Catch-up: only the latest missed date runs.
    scheduledFor = latest && latest > base ? latest : base;
    nextOn = nextAfter(rule, start, scheduledFor);
  } else if (row.mode === 'schedule') {
    const fire = todayIn(zone, new Date(row.next_run_at));
    const latest = lastOnOrBefore(rule, start, today);
    scheduledFor = latest && latest > fire ? nextAfter(rule, start, latest) : (row.next_on as string | null) ?? nextAfter(rule, start, fire);
    nextOn = nextAfter(rule, start, scheduledFor);
    sourceTaskId = row.task_id;
  } else {
    const source = await loadTask(service, row.task_id);
    if (source && source.status !== 'done') {
      // Reopened before the copy was made: wait for done again.
      await service.from('schedules').update({ next_run_at: null, done_on: null }).eq('id', row.id).eq('status', 'active');
      return;
    }
    const doneOn = (row.done_on as string | null) ?? today;
    // Each copy gets a new date: counted from the latest of the day it was
    // done, its own due date and the last date this repeat made, so two
    // copies completed on one day never ask for the same date.
    const { data: last } = await service.from('schedule_occurrences').select('scheduled_for').eq('schedule_id', row.id)
      .order('scheduled_for', { ascending: false }).limit(1).maybeSingle();
    const after = [doneOn, source?.due_date as string | null, day((last as Row | null)?.scheduled_for)]
      .filter((value): value is string => !!value).sort().pop() as string;
    scheduledFor = nextAfter(rule, doneOn, after);
    sourceTaskId = row.task_id;
  }

  if (row.end_date && scheduledFor > row.end_date) return endSchedule(service, row, summary);
  if (row.kind === 'template' || row.mode === 'schedule') {
    if (row.end_date && nextOn && nextOn > row.end_date) {
      status = 'ended';
      nextOn = null;
    } else {
      nextRunAt = startOf(row.kind === 'template' ? nextOn as string : scheduledFor, zone);
    }
  }
  const { data: occurrenceId, error } = await service.rpc('claim_schedule_occurrence', {
    p_schedule_id: row.id, p_expected_run_at: row.next_run_at, p_scheduled_for: scheduledFor, p_next_on: nextOn, p_next_run_at: nextRunAt,
    p_status: status, p_source_task_id: sourceTaskId,
  });
  if (error) fail(error);
  if (status === 'ended') summary.ended++;
  if (!occurrenceId) return;
  summary.due++;
  await execute(service, row, occurrenceId as string, scheduledFor, sourceTaskId, 1, summary);
}

/** Retries a failed occurrence once, or one that stopped before it finished. */
async function processRetry(service: SupabaseClient, occurrence: Row, now: Date, summary: ScheduleRunSummary): Promise<void> {
  const { data: schedule } = await service.from('schedules').select(COLUMNS).eq('id', occurrence.schedule_id).is('deleted_at', null).in('status', ['active', 'ended']).maybeSingle();
  if (!schedule) {
    // Paused or removed since: a failure there is not tried again.
    await service.from('schedule_occurrences').update({ status: 'failed', attempts: Math.max(2, occurrence.attempts as number), finished_at: now.toISOString() })
      .eq('id', occurrence.id).eq('status', occurrence.status).eq('attempts', occurrence.attempts);
    return;
  }
  const row = normalize(schedule as Row);
  // A run that stopped before it finished may have made its work: count it, never make it twice.
  if (occurrence.status === 'running') {
    if (row.kind === 'template') {
      const { data: made } = await service.from('task_template_runs').select('id').eq('schedule_id', row.id).gte('created_at', occurrence.started_at).limit(1).maybeSingle();
      if (made) {
        await service.from('schedule_occurrences').update({ status: 'created', run_id: (made as Row).id, finished_at: now.toISOString() }).eq('id', occurrence.id).eq('status', 'running');
        return;
      }
    } else if (occurrence.source_task_id && row.task_id && row.task_id !== occurrence.source_task_id) {
      await service.from('schedule_occurrences').update({ status: 'created', task_id: row.task_id, finished_at: now.toISOString() }).eq('id', occurrence.id).eq('status', 'running');
      return;
    }
  }
  const attempts = (occurrence.attempts as number) + 1;
  const { data: claimed } = await service.from('schedule_occurrences').update({ status: 'running', attempts, started_at: now.toISOString(), error: null })
    .eq('id', occurrence.id).eq('status', occurrence.status).eq('attempts', occurrence.attempts).select('id');
  if (!claimed?.length) return;
  summary.retried++;
  await execute(service, row, occurrence.id, occurrence.scheduled_for, occurrence.source_task_id ?? null, attempts, summary);
}

/**
 * While the AI agents module is off, agents do nothing: a schedule run by an
 * agent is held back, unclaimed (pm.schedules_kick skips it too), so it
 * runs its latest date when the module is on again. Answers the agents
 * whose schedules wait, empty while the module is on.
 */
async function agentRunnersHeldBack(service: SupabaseClient): Promise<Set<string>> {
  const modules = await readEnabledModules(service);
  if (!modules) throw new Error('Could not read which features are switched on');
  if (modules.includes('agents')) return new Set();
  const { data, error } = await service.from('team_members').select('id').eq('role', 'agent');
  if (error) throw error;
  return new Set(((data ?? []) as Row[]).map((m) => m.id as string));
}

/**
 * Runs everything due: retries first (a failed occurrence once more, one
 * that stopped before it finished), then each due schedule's occurrence,
 * oldest first, up to `limit` of each per call. Safe to call from two places
 * at once: each occurrence is claimed before anything is made.
 */
export async function runDueSchedules(service: SupabaseClient, now = new Date(), limit = 25): Promise<ScheduleRunSummary> {
  const summary: ScheduleRunSummary = { due: 0, created: 0, skipped: 0, failed: 0, retried: 0, paused: 0, ended: 0 };
  const heldBack = await agentRunnersHeldBack(service);
  const held = (row: Row) => heldBack.has((row.run_as ?? row.created_by) as string);
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();
  const { data: retries, error: retryError } = await service.from('schedule_occurrences').select(OCCURRENCE_COLUMNS)
    .or(`and(status.eq.failed,attempts.lt.2),and(status.eq.running,started_at.lt."${cutoff}")`).order('started_at').limit(limit);
  if (retryError) fail(retryError);
  const retrying = ((retries ?? []) as Row[]).map((o): Row => ({ ...o, scheduled_for: day(o.scheduled_for) }));
  const heldSchedules = new Set<string>();
  if (heldBack.size && retrying.length) {
    const { data: owners } = await service.from('schedules').select('id, run_as, created_by').in('id', [...new Set(retrying.map((o) => o.schedule_id as string))]);
    for (const schedule of (owners ?? []) as Row[]) if (held(schedule)) heldSchedules.add(schedule.id as string);
  }
  for (const occurrence of retrying.filter((o) => !heldSchedules.has(o.schedule_id))) {
    if (occurrence.status === 'running' && occurrence.attempts >= 2) {
      // Its second try stopped before it finished: no third.
      const { data: stopped } = await service.from('schedule_occurrences').update({ status: 'failed', error: 'Stopped before it finished, twice', finished_at: now.toISOString() })
        .eq('id', occurrence.id).eq('status', 'running').select('id');
      if (stopped?.length) {
        const { data: schedule } = await service.from('schedules').select(COLUMNS).eq('id', occurrence.schedule_id).maybeSingle();
        const { data: paused } = await service.from('schedules').update({ status: 'paused', paused_reason: 'failed_twice', last_outcome: 'failed' }).eq('id', occurrence.schedule_id).eq('status', 'active').select('id');
        if (paused?.length && schedule) { summary.paused++; await notifyPaused(service, schedule as Row, 'failed_twice'); }
      }
      continue;
    }
    await processRetry(service, occurrence, now, summary);
  }
  let dueQuery = service.from('schedules').select(COLUMNS).eq('status', 'active').is('deleted_at', null)
    .lte('next_run_at', now.toISOString());
  // Held back in the query too, so they never crowd out the rest.
  // A schedule with no run_as (its creator runs it) stays in: held() checks its creator below.
  if (heldBack.size) dueQuery = dueQuery.or(`run_as.is.null,run_as.not.in.(${[...heldBack].join(',')})`);
  const { data: due, error } = await dueQuery.order('next_run_at').limit(limit);
  if (error) fail(error);
  for (const row of ((due ?? []) as Row[]).map(normalize).filter((r) => !held(r))) {
    try {
      await processDue(service, row, now, summary);
    } catch (error) {
      console.error('[schedules] could not process a schedule', row.id, error);
    }
  }
  return summary;
}
