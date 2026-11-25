import type { SupabaseClient } from '@supabase/supabase-js';
import {
  missingValues, planRun, taskCount, TEMPLATE_FIELDS_MAX, isCalendarDate, type CreateTaskTemplateInput, type PlannedTask,
  type RunTaskTemplateInput, type TaskTemplateRunResult, type TaskTemplateRunView, type TaskTemplateSummary, type TaskTemplateView,
  type TemplateField, type TemplateRunVia, type TemplateTask, type UpdateTaskTemplateInput, usedPlaceholders,
} from '@/lib/task-templates';
import { toLocalDateString } from '@/lib/date-utils';
import { moveToTrash } from '@/lib/supabase/trash';
import { accessAllowsProject, resolveMemberAccess } from './access';
import { callerChannel, callerHolds, type AgentCaller } from './agent-owners';
import { loadMemberRules } from './agent-rules';
import { requireAssistantSwitch } from './assistant';
import { insertTask } from '@/lib/supabase/queries';
import { subtaskRuleError } from './subtasks';
import { sanitizeSearch } from './pagination';
import { assertProjectWritable } from './request-gate';
import { trashForApi } from './trash';
import { ApiError, forbidden, notFound } from './errors';

/**
 * Task templates for the API (v1, MCP) and the session routes. Routes run on
 * the service role, so the rules are here:
 * - Reading the library: whoever may create tasks or manage templates. A
 *   template locked to a project reads as missing to whoever cannot open it.
 * - Writing (create, edit, Trash): templates.manage (Owners and Admins by
 *   default). The creator is recorded; there are no personal templates.
 * - Using one: what creating tasks in its project needs (tasks.create and
 *   the project). A locked template creates only in its own project.
 * - A use checks once what createTaskAs checks per task (the project, the
 *   runner's reach and rules, each assignee's reach), then saves every task
 *   through save_task, the one task write, so activity, task events and
 *   task.created webhooks follow as for any task, then records one run. If
 *   anything fails, run included, the tasks made go to Trash and nothing is
 *   recorded, so a retry never doubles a playbook.
 * Lists are paged and every read is a fixed number of queries.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_COLUMNS = 'id, name, description, project_id, fields, items, version, created_by, created_at, updated_at';
const RUN_COLUMNS = 'id, template_id, template_version, snapshot, project_id, run_by, via, schedule_id, start_date, field_values, task_ids, created_at';

/** A database without the template tables yet (new code before its migration). */
export const missingTemplatesSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code ?? '') || /task_template.*(does not exist|schema cache)/i.test(error.message ?? ''));

export const templatesMigrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Task templates work once the database update 20261125000300_task_templates.sql is applied', { reason: 'migration_pending' });

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingTemplatesSchema(error)) throw templatesMigrationPending();
  throw error;
}

/** Subtasks saved at once: enough to finish a 200-task playbook in a few seconds, few enough to be gentle on the database. */
const SUBTASK_BATCH = 10;

const unprocessable = (message: string, details: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

// ── Who may do what ─────────────────────────────────────────────────────

/** May create, edit and Trash templates. */
export function canManageTemplates(caller: AgentCaller): boolean {
  return callerHolds(caller, 'templates.manage');
}

/** May use templates: create tasks (where the project allows). */
export function canRunTemplates(caller: AgentCaller): boolean {
  return callerHolds(caller, 'tasks.create');
}

function requireManage(caller: AgentCaller): void {
  if (canManageTemplates(caller)) return;
  throw forbidden('Only a member with templates.manage changes templates', {
    reason: 'missing_permission', needs: 'templates.manage',
    hint: 'Ask an Owner or Admin to make the change, or to grant you Manage templates.',
  });
}

function requireRead(caller: AgentCaller): void {
  if (canManageTemplates(caller) || canRunTemplates(caller)) return;
  throw forbidden('Templates are for members who may create tasks', {
    reason: 'missing_permission', needs: 'tasks.create',
    hint: 'Ask an Owner to grant you Create tasks.',
  });
}

const reaches = (caller: AgentCaller, projectId: string) => accessAllowsProject(caller.access, projectId, callerChannel(caller));
const readsAllProjects = (caller: AgentCaller) => callerHolds(caller, 'projects.read_all');

// ── Presenting ──────────────────────────────────────────────────────────

const itemsOf = (row: Row): TemplateTask[] => (Array.isArray(row.items) ? row.items as TemplateTask[] : []);
const fieldsOf = (row: Row): TemplateField[] => (Array.isArray(row.fields) ? row.fields as TemplateField[] : []);

async function projectNames(service: SupabaseClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('projects').select('id, name').in('id', unique).is('deleted_at', null);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
}

async function memberNames(service: SupabaseClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('team_members').select('id, name').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
}

async function runStats(service: SupabaseClient, ids: string[]): Promise<Map<string, { runs: number; last_run_at: string | null }>> {
  const out = new Map<string, { runs: number; last_run_at: string | null }>();
  if (!ids.length) return out;
  const { data, error } = await service.from('task_template_run_stats').select('template_id, runs, last_run_at').in('template_id', ids);
  if (error) fail(error);
  for (const row of (data ?? []) as Row[]) out.set(row.template_id, { runs: row.runs, last_run_at: row.last_run_at ?? null });
  return out;
}

function summary(row: Row, projects: Map<string, string>, stats: { runs: number; last_run_at: string | null } | undefined): TaskTemplateSummary {
  const items = itemsOf(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    project_id: row.project_id ?? null,
    project_name: row.project_id ? projects.get(row.project_id) ?? null : null,
    fields: fieldsOf(row),
    item_count: items.length,
    task_count: taskCount(items),
    version: row.version,
    run_count: stats?.runs ?? 0,
    last_run_at: stats?.last_run_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Reading ─────────────────────────────────────────────────────────────

export interface TemplateFilters {
  search?: string | null;
  /** Only templates usable in this project: unlocked ones and the ones locked to it. */
  project_id?: string | null;
  offset: number;
  limit: number;
}

export function templateFiltersFrom(searchParams: URLSearchParams): Omit<TemplateFilters, 'offset' | 'limit'> {
  const projectId = searchParams.get('project_id');
  if (projectId && !UUID.test(projectId)) {
    throw unprocessable('project_id must be a uuid', { reason: 'invalid_filter' });
  }
  return { search: searchParams.get('search'), project_id: projectId };
}

/** The templates the caller may read, by name, paged (without their tasks). */
export async function listTemplates(service: SupabaseClient, caller: AgentCaller, filters: TemplateFilters): Promise<{ rows: TaskTemplateSummary[]; total: number }> {
  requireRead(caller);
  let query = service.from('task_templates').select(SUMMARY_COLUMNS, { count: 'exact' }).is('deleted_at', null);
  if (filters.project_id) {
    if (!reaches(caller, filters.project_id)) return { rows: [], total: 0 };
    query = query.or(`project_id.is.null,project_id.eq.${filters.project_id}`);
  } else if (!readsAllProjects(caller)) {
    // A locked template shows only to whoever can open its project.
    const reachable = caller.access.project_ids.filter((id) => UUID.test(id) && reaches(caller, id));
    query = reachable.length ? query.or(`project_id.is.null,project_id.in.(${reachable.join(',')})`) : query.is('project_id', null);
  }
  const search = filters.search ? sanitizeSearch(filters.search.trim()) : '';
  if (search) query = query.ilike('name', `%${search}%`);
  const { data, count, error } = await query.order('name').order('id').range(filters.offset, filters.offset + filters.limit - 1);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const [projects, stats] = await Promise.all([projectNames(service, rows.map((r) => r.project_id)), runStats(service, rows.map((r) => r.id))]);
  return { rows: rows.map((row) => summary(row, projects, stats.get(row.id))), total: count ?? rows.length };
}

async function loadTemplateRow(service: SupabaseClient, caller: AgentCaller, templateId: string): Promise<Row> {
  requireRead(caller);
  if (!UUID.test(templateId)) throw notFound('Template');
  const { data, error } = await service.from('task_templates').select(SUMMARY_COLUMNS).eq('id', templateId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  // In Trash, locked to a project out of reach, and missing read the same.
  if (!data) throw notFound('Template');
  const row = data as Row;
  if (row.project_id && !reaches(caller, row.project_id)) throw notFound('Template');
  return row;
}

export async function getTemplate(service: SupabaseClient, caller: AgentCaller, templateId: string): Promise<TaskTemplateView> {
  const row = await loadTemplateRow(service, caller, templateId);
  const [projects, stats, names] = await Promise.all([
    projectNames(service, [row.project_id]), runStats(service, [row.id]), memberNames(service, [row.created_by]),
  ]);
  return { ...summary(row, projects, stats.get(row.id)), items: itemsOf(row), created_by_name: row.created_by ? names.get(row.created_by) ?? null : null };
}

// ── Writing ─────────────────────────────────────────────────────────────

/** A locked project must be live and one the caller can open. */
async function checkProject(service: SupabaseClient, caller: AgentCaller, projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  const { data, error } = await service.from('projects').select('id').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data || !reaches(caller, projectId)) {
    throw unprocessable('Lock it to a project you can open', { reason: 'project_not_found', fields: { project_id: 'Pick a project you can open.' } });
  }
}

/** Named assignees must be active team members when the template is saved. */
async function checkAssignees(service: SupabaseClient, items: readonly TemplateTask[]): Promise<void> {
  const ids = [...new Set(items.flatMap((task) => [task.assignee, ...(task.subtasks ?? []).map((s) => s.assignee)])
    .filter((id): id is string => !!id && UUID.test(id)))];
  if (!ids.length) return;
  const { data, error } = await service.from('team_members').select('id, status').in('id', ids);
  if (error) throw error;
  const active = new Set(((data ?? []) as { id: string; status: string | null }[]).filter((m) => (m.status ?? 'active') === 'active').map((m) => m.id));
  const missing = ids.filter((id) => !active.has(id));
  if (missing.length) {
    throw unprocessable('Every assignee must be an active team member', { reason: 'assignee_not_active', member_ids: missing });
  }
}

export async function createTemplate(service: SupabaseClient, caller: AgentCaller, input: CreateTaskTemplateInput): Promise<TaskTemplateView> {
  requireManage(caller);
  await checkProject(service, caller, input.project_id);
  await checkAssignees(service, input.items);
  const { data, error } = await service.from('task_templates').insert({
    name: input.name,
    description: input.description ?? '',
    project_id: input.project_id ?? null,
    fields: input.fields ?? [],
    items: input.items,
    created_by: caller.memberId,
    updated_by: caller.memberId,
  }).select('id').single();
  if (error) fail(error);
  return getTemplate(service, caller, (data as Row).id);
}

export async function updateTemplate(service: SupabaseClient, caller: AgentCaller, templateId: string, input: UpdateTaskTemplateInput): Promise<{ before: TaskTemplateView; template: TaskTemplateView }> {
  requireManage(caller);
  const before = await getTemplate(service, caller, templateId);
  const items = input.items ?? before.items;
  const fields = input.fields ?? before.fields;
  // The fill-ins and the fields must still agree when only one of them is sent.
  const declared = new Set(fields.map((field) => field.key));
  const undeclared = [...usedPlaceholders(items)].filter((key) => !declared.has(key));
  if (undeclared.length) {
    throw unprocessable(`Declare a fill-in field for ${undeclared.map((key) => `{${key}}`).join(', ')}`, { reason: 'undeclared_field', keys: undeclared });
  }
  if (fields.length > TEMPLATE_FIELDS_MAX) throw unprocessable(`A template has ${TEMPLATE_FIELDS_MAX} fill-in fields at most`, { reason: 'too_many_fields' });
  if (input.project_id !== undefined) await checkProject(service, caller, input.project_id);
  if (input.items) await checkAssignees(service, input.items);
  const changes: Row = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
    ...(input.items !== undefined ? { items: input.items } : {}),
    updated_by: caller.memberId,
  };
  const { error } = await service.from('task_templates').update(changes).eq('id', templateId).is('deleted_at', null);
  if (error) fail(error);
  return { before, template: await getTemplate(service, caller, templateId) };
}

/**
 * Moves a template to Trash (Settings > Trash lists it and restores it). The
 * tasks it already made stay as they are; so do its runs.
 */
export async function trashTemplate(service: SupabaseClient, caller: AgentCaller, templateId: string): Promise<TaskTemplateView> {
  requireManage(caller);
  const template = await getTemplate(service, caller, templateId);
  await trashForApi(service, 'task_templates', templateId, caller.memberId, 'Template');
  return template;
}

// ── Runs ────────────────────────────────────────────────────────────────

function presentRun(row: Row, projects: Map<string, string>, names: Map<string, string>): TaskTemplateRunView {
  return {
    id: row.id,
    template_id: row.template_id,
    template_version: row.template_version,
    template_name: (row.snapshot?.name as string | undefined) ?? '',
    project_id: row.project_id,
    project_name: projects.get(row.project_id) ?? null,
    run_by: row.run_by ?? null,
    run_by_name: row.run_by ? names.get(row.run_by) ?? null : null,
    via: row.via as TemplateRunVia,
    schedule_id: row.schedule_id ?? null,
    // A date column: YYYY-MM-DD, however the driver hands it over.
    start_date: String(row.start_date ?? '').slice(0, 10),
    values: (row.field_values ?? {}) as Record<string, string>,
    task_ids: (row.task_ids ?? []) as string[],
    created_at: row.created_at,
  };
}

/** A template's runs, newest first, paged: on the projects the caller can open. */
export async function listRuns(service: SupabaseClient, caller: AgentCaller, templateId: string, page: { offset: number; limit: number }): Promise<{ rows: TaskTemplateRunView[]; total: number }> {
  await loadTemplateRow(service, caller, templateId);
  let query = service.from('task_template_runs').select(RUN_COLUMNS, { count: 'exact' }).eq('template_id', templateId);
  if (!readsAllProjects(caller)) {
    const reachable = caller.access.project_ids.filter((id) => UUID.test(id) && reaches(caller, id));
    if (!reachable.length) return { rows: [], total: 0 };
    query = query.in('project_id', reachable);
  }
  const { data, count, error } = await query.order('created_at', { ascending: false }).order('id').range(page.offset, page.offset + page.limit - 1);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const [projects, names] = await Promise.all([projectNames(service, rows.map((r) => r.project_id)), memberNames(service, rows.map((r) => r.run_by))]);
  return { rows: rows.map((row) => presentRun(row, projects, names)), total: count ?? rows.length };
}

/** Today in the runner's own time zone (the workspace's day when they have none). */
async function runnerToday(service: SupabaseClient, memberId: string): Promise<string> {
  const { data } = await service.from('team_members').select('timezone').eq('id', memberId).maybeSingle();
  const zone = (data as { timezone?: string | null } | null)?.timezone || undefined;
  try {
    return toLocalDateString(zone);
  } catch {
    return toLocalDateString();
  }
}

/**
 * Who each planned assignee really is: an active member who can open the
 * project. Anyone else is left off, and a note says so, so a use (or a
 * schedule later) never fails because someone left a project.
 */
async function resolveAssignees(service: SupabaseClient, plan: PlannedTask[], projectId: string, projectName: string): Promise<{ allowed: Set<string>; notes: string[] }> {
  const ids = [...new Set(plan.flatMap((task) => [task.assignee_id, ...task.subtasks.map((s) => s.assignee_id)]).filter((id): id is string => !!id))];
  const allowed = new Set<string>();
  const refused: string[] = [];
  const reach = await Promise.all(ids.map(async (id) => {
    const access = await resolveMemberAccess(service, id);
    return !!access && access.status === 'active'
      && (accessAllowsProject(access, projectId, 'app') || accessAllowsProject(access, projectId, 'api'));
  }));
  ids.forEach((id, i) => (reach[i] ? allowed.add(id) : refused.push(id)));
  const notes: string[] = [];
  if (refused.length) {
    const names = await memberNames(service, refused);
    for (const id of refused) {
      const titles = plan.flatMap((task) => [task, ...task.subtasks]).filter((task) => task.assignee_id === id).map((task) => `"${task.title}"`);
      notes.push(`${names.get(id) ?? 'Someone'} cannot open ${projectName}, so ${titles.join(', ')} ${titles.length === 1 ? 'is' : 'are'} unassigned.`);
    }
  }
  return { allowed, notes };
}

/**
 * Uses a template: every task (and subtask) created in the project through
 * the task service (save_task), then one run recorded. via says where the
 * use came from. If anything fails, the tasks made go to Trash and no run is
 * recorded. A 200-task playbook is about 65 round trips in a row.
 */
export async function runTemplate(
  service: SupabaseClient,
  caller: AgentCaller,
  templateId: string,
  input: RunTaskTemplateInput,
  via: Exclude<TemplateRunVia, 'schedule'>,
): Promise<TaskTemplateRunResult> {
  const row = await loadTemplateRow(service, caller, templateId);
  if (!canRunTemplates(caller)) {
    throw forbidden('Using a template creates tasks, which needs tasks.create', {
      reason: 'missing_permission', needs: 'tasks.create', hint: 'Ask an Owner to grant you Create tasks.',
    });
  }
  const lockedTo = (row.project_id as string | null) ?? null;
  if (lockedTo && input.project_id && input.project_id !== lockedTo) {
    throw unprocessable('This template is locked to another project and always creates there', {
      reason: 'locked_to_project', project_id: lockedTo, fields: { project_id: 'This template always creates in its own project.' },
    });
  }
  const projectId = lockedTo ?? input.project_id ?? null;
  if (!projectId) throw unprocessable('Pick the project the tasks go in', { reason: 'project_required', fields: { project_id: 'Pick a project.' } });
  const { data: project, error: projectError } = await service.from('projects').select('id, name').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (projectError) throw projectError;
  if (!project) throw notFound('Project');
  const channel = callerChannel(caller);
  if (!accessAllowsProject(caller.access, projectId, channel)) {
    throw forbidden('Project scope denied', { reason: 'project_scope', project_id: projectId, hint: 'You can use templates only in projects you can open.' });
  }
  // The rules an agent runs under apply as for any task it creates.
  await requireAssistantSwitch(service, caller.memberId, caller.access, 'create_tasks');
  assertProjectWritable(projectId);
  const member = await loadMemberRules(service, caller.memberId);
  if (member.isAgent && member.rules.agent_create_policy === 'approval') {
    throw forbidden(`${member.name}'s rules need someone to approve its new tasks, so it cannot use templates`, {
      reason: 'needs_approval', hint: 'Suggest the tasks instead, or ask an owner to change its rules.',
    });
  }

  const fields = fieldsOf(row);
  const values = Object.fromEntries(fields.map((field) => [field.key, (input.values?.[field.key] ?? '').trim()]));
  const missing = missingValues(fields, values);
  if (missing.length) {
    throw unprocessable(`Fill in ${missing.map((field) => field.label).join(', ')}`, {
      reason: 'missing_values', keys: missing.map((field) => field.key),
      fields: Object.fromEntries(missing.map((field) => [`values.${field.key}`, `Fill in ${field.label}.`])),
    });
  }
  if (input.start_date && !isCalendarDate(input.start_date)) {
    throw unprocessable('start_date is not a real date', { reason: 'invalid_date', fields: { start_date: 'Pick a real date.' } });
  }
  const startDate = input.start_date ?? await runnerToday(service, caller.memberId);
  const items = itemsOf(row);
  const plan = planRun(items, { startDate, values, runnerId: caller.memberId });
  const projectName = (project as { name: string }).name;
  const { allowed, notes } = await resolveAssignees(service, plan, projectId, projectName);

  // The template's author (templates.manage) chose who does each task, so
  // its assignees stand whatever the runner may assign; nobody named is
  // nobody, never the runner. Everything createTaskAs checks per task was
  // checked once above (the project, the runner's reach and rules, each
  // assignee's reach), so each task is one save_task call, the same one
  // every task goes through: activity, task events and task.created
  // webhooks fire as for any task.
  const sourceNote = `From the template "${row.name}"`.slice(0, 200);
  type Saved = Awaited<ReturnType<typeof insertTask>>;
  const save = (task: Omit<PlannedTask, 'subtasks'>, parent: { id: string; order: number } | null): Promise<Saved> => insertTask(
    service,
    {
      project_id: projectId,
      title: task.title,
      description: task.description,
      status: 'todo',
      priority: task.priority,
      due_date: task.due_date,
      tags: task.tags,
      created_by: caller.memberId,
      created_note: sourceNote,
      ...(parent ? { parent_task_id: parent.id, sort_order: parent.order } : {}),
    } as Parameters<typeof insertTask>[1],
    task.assignee_id && allowed.has(task.assignee_id) ? [task.assignee_id] : [],
  ).catch((error: unknown) => { throw subtaskRuleError(error); });

  const parents: Saved[] = [];
  const subtasks = new Map<string, Saved[]>();
  try {
    // Top-level tasks in order, so they land on the board as listed; then
    // every subtask, a batch at a time (each carries its place under its parent).
    for (const task of plan) parents.push(await save(task, null));
    const pending = plan.flatMap((task, i) => task.subtasks.map((subtask, order) => ({ subtask, order, parent: parents[i] })));
    for (let start = 0; start < pending.length; start += SUBTASK_BATCH) {
      const batch = pending.slice(start, start + SUBTASK_BATCH);
      const settled = await Promise.allSettled(batch.map(({ subtask, order, parent }) => save(subtask, { id: parent.id, order })));
      settled.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          const parentId = batch[i].parent.id;
          subtasks.set(parentId, [...(subtasks.get(parentId) ?? []), result.value]);
        }
      });
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    // Each subtask after its parent, in their order.
    const created = parents.flatMap((parent) => [parent, ...(subtasks.get(parent.id) ?? []).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))]);
    const { data: run, error: runError } = await service.from('task_template_runs').insert({
      template_id: row.id,
      template_version: row.version,
      snapshot: { name: row.name, description: row.description ?? '', fields, items },
      project_id: projectId,
      run_by: caller.memberId,
      via,
      start_date: startDate,
      field_values: values,
      task_ids: created.map((task) => task.id),
    }).select(RUN_COLUMNS).single();
    if (runError) fail(runError);
    const names = await memberNames(service, [caller.memberId]);
    return {
      run: presentRun(run as Row, new Map([[projectId, projectName]]), names),
      tasks: created as unknown as Row[],
      notes,
    };
  } catch (error) {
    // Nothing half made, and nothing a retry would double: the tasks
    // already created (their subtasks go with them) go to Trash.
    await Promise.all(parents.map((parent) => moveToTrash(service, 'tasks', parent.id, caller.memberId).catch((trashError: unknown) => {
      console.error('[task-templates] could not move a partly made task to Trash', parent.id, trashError);
    })));
    throw error;
  }
}
