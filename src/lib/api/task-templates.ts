import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assignTemplateKeys, isCalendarDate, issuesFromZod, keyDatesOf, mainKeyDate, missingValues, pastDueOf, planRun, RUNNER, taskCount,
  TEMPLATE_FIELD_KEY, templateDocumentSchema, templateIssue, templateIssues, templatePatchSchema, templateScope,
  type PlannedTask, type RunTaskTemplateInput, type TaskTemplateRunResult, type TaskTemplateRunView, type TaskTemplateSummary,
  type TaskTemplateView, type TemplateField, type TemplateIssue, type TemplateKeyDate, type TemplateRole,
  type TemplatePastDue, type TemplateRunInitiative, type TemplateRunVia, type TemplateScope, type TemplateTask,
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
import { createInitiative } from './initiatives';
import { ApiError, forbidden, notFound } from './errors';

/**
 * Task templates for the API (v1, MCP) and the session routes. Routes run on
 * the service role, so the rules are here:
 * - Reading the library: whoever may create tasks or manage templates. A
 *   project's template reads as missing to whoever cannot open the project.
 * - Writing (create, edit, Trash): a company-wide template (project_id null)
 *   needs templates.manage; a project's template needs the project and
 *   projects.manage (whoever manages the project) or templates.manage.
 *   Moving one between scopes needs both. The creator is recorded.
 * - Every write and validateTemplate check the same rules (the shape from
 *   templateDocumentSchema, templateIssues, then the workspace: the project,
 *   assignees and default role members), and refuse with every error, each
 *   with its JSON path and a fix.
 * - Using one: what creating tasks in its project needs (tasks.create and
 *   the project). A project's template creates only in its project.
 * - A use (createTemplateRun, the one way a run is made: by hand, API, MCP,
 *   and later reflow, drafts and schedules) checks once what createTaskAs
 *   checks per task (the project, the runner's reach and rules, each
 *   assignee's reach). A role the runner maps to someone else needs
 *   tasks.manage_all (assigning others); assignees and default role members
 *   written in the template stand, since its author chose them. It makes the
 *   run's initiative when asked (create_initiative true; off by default,
 *   so existing callers see no change), saves every task through save_task (so
 *   activity, task events and task.created webhooks follow as for any task),
 *   carries dependencies into task dependencies, then records the run and
 *   its task links in one transaction. If anything fails, the tasks and the
 *   initiative go to Trash and nothing is recorded, so a retry never doubles
 *   a playbook. previewTemplateRun is the same plan, writing nothing.
 * - A draft (template-drafts.ts) plans from the template as it saw it (its
 *   snapshot) with the steps it adds and removes; approved, it is made here
 *   as the person who approved it, every role map and added step checked
 *   against their own assign rights.
 * - A reflow (template-reflow.ts) moves a live run's key dates.
 * Lists are paged and every read is a fixed number of queries.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_COLUMNS = 'id, name, description, project_id, fields, items, key_dates, roles, guidance, version, created_by, created_at, updated_at';
export const RUN_COLUMNS = 'id, template_id, template_version, snapshot, project_id, run_by, via, schedule_id, start_date, field_values, task_ids, key_dates, role_members, initiative_id, created_at';

/** A database without the template tables or the templates v2 columns yet (new code before its migration). */
export const missingTemplatesSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', '42703', 'PGRST205', 'PGRST204', 'PGRST202', '42883'].includes(error.code ?? '')
    || /task_template.*(does not exist|schema cache)|record_task_template_run/i.test(error.message ?? ''));

export const templatesMigrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Task templates work once the database updates 20261125000300_task_templates.sql and 20261126000200_templates_v2.sql are applied', { reason: 'migration_pending' });

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingTemplatesSchema(error)) throw templatesMigrationPending();
  throw error;
}

/** Subtasks saved at once: enough to finish a 200-task playbook in a few seconds, few enough to be gentle on the database. */
const SUBTASK_BATCH = 10;

const unprocessable = (message: string, details: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

/**
 * A refusal carrying every error: reason is the first one's code, errors
 * each one with its path and fix, fields the same by path. The details
 * 2.0.34 answered stay beside them: keys (missing_values, undeclared_field),
 * project_id (locked_to_project), member_ids (assignee_not_active), and the
 * reason too_many_fields for too many fill-in fields.
 */
export function templateErrors(errors: TemplateIssue[], status = 422): ApiError {
  const first = errors[0];
  const message = errors.length === 1 ? first.message : `${first.message} (and ${errors.length - 1} more)`;
  const of = (code: TemplateIssue['code']) => errors.filter((issue) => issue.code === code);
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))];
  const legacyCode = first.code === 'missing_values' || first.code === 'undeclared_field' ? first.code
    : of('missing_values').length ? 'missing_values' : of('undeclared_field').length ? 'undeclared_field' : null;
  const keys = legacyCode ? unique(of(legacyCode).map((issue) => issue.field)) : [];
  const memberIds = unique(of('assignee_not_active').map((issue) => issue.member_id));
  const locked = of('locked_to_project')[0]?.project_id;
  return new ApiError(status, status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR', message, {
    reason: first.code === 'out_of_range' && first.path === 'fields' ? 'too_many_fields' : first.code,
    errors: errors.map(({ segments: _segments, ...issue }) => issue),
    fields: Object.fromEntries(errors.map((issue) => [issue.path, issue.message])),
    ...(keys.length ? { keys } : {}),
    ...(memberIds.length ? { member_ids: memberIds } : {}),
    ...(locked ? { project_id: locked } : {}),
    hint: 'Fix each error at its path and send it again. POST /api/v1/task-templates/validate checks a template without saving it.',
  });
}

const publicIssues = (errors: TemplateIssue[]) => errors.map(({ segments: _segments, ...issue }) => issue);

// ── Who may do what ─────────────────────────────────────────────────────

const reaches = (caller: AgentCaller, projectId: string) => accessAllowsProject(caller.access, projectId, callerChannel(caller));
const readsAllProjects = (caller: AgentCaller) => callerHolds(caller, 'projects.read_all');

/** May manage the company-wide library (and any project's templates it can open). */
export function canManageTemplates(caller: AgentCaller): boolean {
  return callerHolds(caller, 'templates.manage');
}

/** May use templates: create tasks (where the project allows). */
export function canRunTemplates(caller: AgentCaller): boolean {
  return callerHolds(caller, 'tasks.create');
}

/**
 * May create, change and Trash a template in this scope: company-wide needs
 * templates.manage; a project's needs the project and projects.manage
 * (whoever manages the project) or templates.manage.
 */
export function canWriteTemplate(caller: AgentCaller, projectId: string | null): boolean {
  if (!projectId) return canManageTemplates(caller);
  return reaches(caller, projectId) && (canManageTemplates(caller) || callerHolds(caller, 'projects.manage'));
}

function requireSomeWrite(caller: AgentCaller): void {
  if (canManageTemplates(caller) || callerHolds(caller, 'projects.manage')) return;
  throw forbidden('Only a member with templates.manage changes templates, or projects.manage for a project\'s own templates', {
    reason: 'missing_permission', needs: 'templates.manage',
    hint: 'Ask an Owner or Admin to make the change, or to grant you Manage templates.',
  });
}

function requireWrite(caller: AgentCaller, projectId: string | null): void {
  if (canWriteTemplate(caller, projectId)) return;
  if (!projectId) {
    throw forbidden('Only a member with templates.manage changes company-wide templates', {
      reason: 'missing_permission', needs: 'templates.manage',
      hint: 'Ask an Owner or Admin to make the change, or keep the template in a project you manage.',
    });
  }
  throw forbidden('Only whoever manages this project (projects.manage) or templates.manage changes its templates', {
    reason: 'missing_permission', needs: ['projects.manage', 'templates.manage'], project_id: projectId,
    hint: 'Ask an Owner or a project manager to make the change.',
  });
}

function requireRead(caller: AgentCaller): void {
  if (canManageTemplates(caller) || canRunTemplates(caller)) return;
  throw forbidden('Templates are for members who may create tasks', {
    reason: 'missing_permission', needs: 'tasks.create',
    hint: 'Ask an Owner to grant you Create tasks.',
  });
}

// ── Presenting ──────────────────────────────────────────────────────────

const itemsOf = (row: Row): TemplateTask[] => assignTemplateKeys(Array.isArray(row.items) ? row.items as TemplateTask[] : []);
const fieldsOf = (row: Row): TemplateField[] => (Array.isArray(row.fields) ? row.fields as TemplateField[] : []);
const keyDatesOfRow = (row: Row): TemplateKeyDate[] => keyDatesOf(Array.isArray(row.key_dates) ? row.key_dates as TemplateKeyDate[] : null);
const rolesOf = (row: Row): TemplateRole[] => (Array.isArray(row.roles) ? row.roles as TemplateRole[] : []);

export async function projectNames(service: SupabaseClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('projects').select('id, name').in('id', unique).is('deleted_at', null);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
}

export async function memberNames(service: SupabaseClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('team_members').select('id, name').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
}

/** Active members by id, with their names. */
export async function activeMembers(service: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id && UUID.test(id)))];
  if (!unique.length) return new Map();
  const { data, error } = await service.from('team_members').select('id, name, status').in('id', unique);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string; status: string | null }[])
    .filter((m) => (m.status ?? 'active') === 'active').map((m) => [m.id, m.name]));
}

async function runStats(service: SupabaseClient, ids: string[]): Promise<Map<string, { runs: number; last_run_at: string | null }>> {
  const out = new Map<string, { runs: number; last_run_at: string | null }>();
  if (!ids.length) return out;
  const { data, error } = await service.from('task_template_run_stats').select('template_id, runs, last_run_at').in('template_id', ids);
  if (error) fail(error);
  for (const row of (data ?? []) as Row[]) out.set(row.template_id, { runs: row.runs, last_run_at: row.last_run_at ?? null });
  return out;
}

function summary(caller: AgentCaller, row: Row, projects: Map<string, string>, stats: { runs: number; last_run_at: string | null } | undefined): TaskTemplateSummary {
  const items = Array.isArray(row.items) ? row.items as TemplateTask[] : [];
  const projectId = (row.project_id as string | null) ?? null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    project_id: projectId,
    project_name: projectId ? projects.get(projectId) ?? null : null,
    scope: templateScope(projectId),
    can_edit: canWriteTemplate(caller, projectId),
    key_dates: keyDatesOfRow(row),
    roles: rolesOf(row),
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
  /** Only templates usable in this project: company-wide ones and its own (its own first). */
  project_id?: string | null;
  /** project: only templates that belong to a project; workspace: only company-wide ones. */
  scope?: TemplateScope | null;
  offset: number;
  limit: number;
}

export function templateFiltersFrom(searchParams: URLSearchParams): Omit<TemplateFilters, 'offset' | 'limit'> {
  const projectId = searchParams.get('project_id');
  if (projectId && !UUID.test(projectId)) {
    throw unprocessable('project_id must be a uuid', { reason: 'invalid_filter' });
  }
  const scope = searchParams.get('scope');
  if (scope && scope !== 'project' && scope !== 'workspace') {
    throw unprocessable('scope is project or workspace', { reason: 'invalid_filter', fields: { scope: 'Use project or workspace.' } });
  }
  return { search: searchParams.get('search'), project_id: projectId, scope: (scope as TemplateScope | null) ?? null };
}

/** The templates the caller may read, by name, paged (without their tasks). */
export async function listTemplates(service: SupabaseClient, caller: AgentCaller, filters: TemplateFilters): Promise<{ rows: TaskTemplateSummary[]; total: number }> {
  requireRead(caller);
  let query = service.from('task_templates').select(SUMMARY_COLUMNS, { count: 'exact' }).is('deleted_at', null);
  if (filters.project_id) {
    if (!reaches(caller, filters.project_id)) return { rows: [], total: 0 };
    if (filters.scope === 'project') query = query.eq('project_id', filters.project_id);
    else if (filters.scope === 'workspace') query = query.is('project_id', null);
    else query = query.or(`project_id.is.null,project_id.eq.${filters.project_id}`);
  } else {
    if (filters.scope === 'workspace') query = query.is('project_id', null);
    else if (filters.scope === 'project') query = query.not('project_id', 'is', null);
    if (!readsAllProjects(caller) && filters.scope !== 'workspace') {
      // A project's template shows only to whoever can open its project.
      const reachable = caller.access.project_ids.filter((id) => UUID.test(id) && reaches(caller, id));
      if (filters.scope === 'project') {
        if (!reachable.length) return { rows: [], total: 0 };
        query = query.in('project_id', reachable);
      } else {
        query = reachable.length ? query.or(`project_id.is.null,project_id.in.(${reachable.join(',')})`) : query.is('project_id', null);
      }
    }
  }
  const search = filters.search ? sanitizeSearch(filters.search.trim()) : '';
  if (search) query = query.ilike('name', `%${search}%`);
  // In a project, its own templates come first, then the company's.
  if (filters.project_id) query = query.order('project_id', { ascending: true, nullsFirst: false });
  const { data, count, error } = await query.order('name').order('id').range(filters.offset, filters.offset + filters.limit - 1);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const [projects, stats] = await Promise.all([projectNames(service, rows.map((r) => r.project_id)), runStats(service, rows.map((r) => r.id))]);
  return { rows: rows.map((row) => summary(caller, row, projects, stats.get(row.id))), total: count ?? rows.length };
}

export async function loadTemplateRow(service: SupabaseClient, caller: AgentCaller, templateId: string): Promise<Row> {
  requireRead(caller);
  if (!UUID.test(templateId)) throw notFound('Template');
  const { data, error } = await service.from('task_templates').select(SUMMARY_COLUMNS).eq('id', templateId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  // In Trash, in a project out of reach, and missing read the same.
  if (!data) throw notFound('Template');
  const row = data as Row;
  if (row.project_id && !reaches(caller, row.project_id)) throw notFound('Template');
  return row;
}

export async function getTemplate(service: SupabaseClient, caller: AgentCaller, templateId: string): Promise<TaskTemplateView> {
  const row = await loadTemplateRow(service, caller, templateId);
  return viewOf(service, caller, row);
}

async function viewOf(service: SupabaseClient, caller: AgentCaller, row: Row): Promise<TaskTemplateView> {
  const [projects, stats, names] = await Promise.all([
    projectNames(service, [row.project_id]), runStats(service, [row.id]), memberNames(service, [row.created_by]),
  ]);
  return {
    ...summary(caller, row, projects, stats.get(row.id)),
    items: itemsOf(row),
    guidance: row.guidance ?? '',
    created_by_name: row.created_by ? names.get(row.created_by) ?? null : null,
  };
}

// ── Checking a template ─────────────────────────────────────────────────

/** A template as it will be stored: every part present, every task keyed. */
export interface TemplateContent {
  name: string;
  description: string;
  project_id: string | null;
  guidance: string;
  key_dates: TemplateKeyDate[];
  roles: TemplateRole[];
  fields: TemplateField[];
  items: TemplateTask[];
}

export interface TemplateCheck {
  errors: TemplateIssue[];
  /** The template as it would be saved (keys assigned), when the shape is right. */
  content: TemplateContent | null;
  /** The columns a change writes (an update), when the shape is right. */
  changes: Partial<TemplateContent> | null;
}

const contentOfView = (view: TaskTemplateView): TemplateContent => ({
  name: view.name, description: view.description, project_id: view.project_id, guidance: view.guidance ?? '',
  key_dates: view.key_dates ?? keyDatesOf(null), roles: view.roles ?? [], fields: view.fields, items: view.items,
});

/**
 * Every rule a template must keep, in one pass: the shape (create: the whole
 * template; update: the change), templateIssues on the template as it would
 * be, then the workspace for what the request sets (the project is live and
 * open to the caller, named assignees and default role members are active).
 * before is the template a change applies to.
 */
export async function checkTemplate(service: SupabaseClient, caller: AgentCaller, raw: unknown, before: TaskTemplateView | null): Promise<TemplateCheck> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [templateIssue([], 'invalid_value', 'Send the template as a JSON object', 'GET /api/v1/task-templates/schema has its shape.')], content: null, changes: null };
  }
  const body = raw as Record<string, unknown>;
  const errors: TemplateIssue[] = [];
  let content: TemplateContent | null = null;
  let changes: Partial<TemplateContent> | null = null;
  if (before) {
    const parsed = templatePatchSchema.safeParse(body);
    if (!parsed.success) errors.push(...issuesFromZod(parsed.error));
    if (!Object.values(body).some((value) => value !== undefined)) {
      errors.push(templateIssue([], 'required', 'Send at least one field to change', 'Send only what changes: name, description, project_id, guidance, key_dates, roles, fields or items.'));
    }
    const current = contentOfView(before);
    // The rules read the template as it would be once changed.
    errors.push(...templateIssues({ ...current, ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) }));
    if (parsed.success) {
      const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined)) as Partial<TemplateContent>;
      if (patch.items) patch.items = assignTemplateKeys(patch.items);
      changes = patch;
      content = { ...current, ...patch };
    }
  } else {
    const parsed = templateDocumentSchema.safeParse(body);
    if (!parsed.success) errors.push(...issuesFromZod(parsed.error));
    errors.push(...templateIssues(body));
    if (parsed.success) {
      const value = parsed.data;
      content = {
        name: value.name, description: value.description ?? '', project_id: value.project_id ?? null, guidance: value.guidance ?? '',
        key_dates: keyDatesOf(value.key_dates), roles: value.roles ?? [], fields: value.fields ?? [], items: assignTemplateKeys(value.items),
      };
      changes = content;
    }
  }
  if (content && changes) errors.push(...await workspaceIssues(service, caller, changes));
  return { errors, content: errors.length ? null : content, changes: errors.length ? null : changes };
}

/** The project, assignees and default role members a template sets, against the workspace. */
async function workspaceIssues(service: SupabaseClient, caller: AgentCaller, changes: Partial<TemplateContent>): Promise<TemplateIssue[]> {
  const issues: TemplateIssue[] = [];
  const projectId = changes.project_id;
  const assigneeIds = (changes.items ?? []).flatMap((task) => [task.assignee, ...(task.subtasks ?? []).map((s) => s.assignee)]);
  const defaultIds = (changes.roles ?? []).map((role) => role.default_member_id);
  const [project, active] = await Promise.all([
    projectId ? service.from('projects').select('id').eq('id', projectId).is('deleted_at', null).maybeSingle() : Promise.resolve({ data: null, error: null }),
    activeMembers(service, [...assigneeIds, ...defaultIds]),
  ]);
  if (project.error) throw project.error;
  if (projectId && (!project.data || !reaches(caller, projectId))) {
    issues.push(templateIssue(['project_id'], 'project_not_found', 'Put it in a project you can open', 'Use the id of a live project you can open, or null for a company-wide template.'));
  }
  (changes.items ?? []).forEach((task, i) => {
    const check = (assignee: string | null | undefined, path: (string | number)[]) => {
      if (assignee && assignee !== RUNNER && !active.has(assignee)) {
        issues.push(templateIssue([...path, 'assignee'], 'assignee_not_active', 'Every assignee must be an active team member', 'Use an active member id, "runner" (whoever uses it), or null.', { member_id: assignee }));
      }
    };
    check(task.assignee, ['items', i]);
    (task.subtasks ?? []).forEach((subtask, j) => check(subtask.assignee, ['items', i, 'subtasks', j]));
  });
  (changes.roles ?? []).forEach((role, i) => {
    if (role.default_member_id && !active.has(role.default_member_id)) {
      issues.push(templateIssue(['roles', i, 'default_member_id'], 'member_not_active', `The default member for ${role.label} is not an active team member`, 'Use an active member id (a person or an agent), or null.'));
    }
  });
  return issues;
}

/** What validate answers: every error, and the template as it would be saved. */
export interface TemplateValidation {
  valid: boolean;
  errors: Omit<TemplateIssue, 'segments'>[];
  template: (TemplateContent & { scope: TemplateScope; task_count: number }) | null;
  /** Whether the caller may save it where it is scoped. */
  can_save: boolean;
}

/**
 * Checks a template without saving it: the same rules create and update
 * apply. With templateId, raw is a change to that template.
 */
export async function validateTemplate(service: SupabaseClient, caller: AgentCaller, raw: unknown, templateId?: string | null): Promise<TemplateValidation> {
  requireSomeWrite(caller);
  const before = templateId ? await getTemplate(service, caller, templateId) : null;
  const check = await checkTemplate(service, caller, raw, before);
  const content = check.content;
  return {
    valid: check.errors.length === 0,
    errors: publicIssues(check.errors),
    template: content ? { ...content, scope: templateScope(content.project_id), task_count: taskCount(content.items) } : null,
    can_save: !!content && canWriteTemplate(caller, content.project_id) && (!before || canWriteTemplate(caller, before.project_id)),
  };
}

// ── Writing ─────────────────────────────────────────────────────────────

/** Creates a template: the request is checked whole; every error comes back at once. */
export async function createTemplate(service: SupabaseClient, caller: AgentCaller, raw: unknown): Promise<TaskTemplateView> {
  requireSomeWrite(caller);
  const check = await checkTemplate(service, caller, raw, null);
  if (!check.content) throw templateErrors(check.errors);
  const content = check.content;
  requireWrite(caller, content.project_id);
  const { data, error } = await service.from('task_templates').insert({
    name: content.name,
    description: content.description,
    project_id: content.project_id,
    fields: content.fields,
    items: content.items,
    key_dates: content.key_dates,
    roles: content.roles,
    guidance: content.guidance,
    created_by: caller.memberId,
    updated_by: caller.memberId,
  }).select('id').single();
  if (error) fail(error);
  return getTemplate(service, caller, (data as Row).id);
}

/**
 * Changes a template: only what is sent; arrays are replaced whole. Sending
 * the same change again changes nothing (same keys, same version).
 */
export async function updateTemplate(service: SupabaseClient, caller: AgentCaller, templateId: string, raw: unknown): Promise<{ before: TaskTemplateView; template: TaskTemplateView }> {
  requireSomeWrite(caller);
  const before = await getTemplate(service, caller, templateId);
  requireWrite(caller, before.project_id);
  const check = await checkTemplate(service, caller, raw, before);
  if (!check.content || !check.changes) throw templateErrors(check.errors);
  if (check.changes.project_id !== undefined) requireWrite(caller, check.changes.project_id ?? null);
  const { error } = await service.from('task_templates').update({ ...check.changes, updated_by: caller.memberId }).eq('id', templateId).is('deleted_at', null);
  if (error) fail(error);
  return { before, template: await getTemplate(service, caller, templateId) };
}

/**
 * Moves a template to Trash (Settings > Trash lists it and restores it). The
 * tasks it already made stay as they are; so do its runs.
 */
export async function trashTemplate(service: SupabaseClient, caller: AgentCaller, templateId: string): Promise<TaskTemplateView> {
  requireSomeWrite(caller);
  const template = await getTemplate(service, caller, templateId);
  requireWrite(caller, template.project_id);
  await trashForApi(service, 'task_templates', templateId, caller.memberId, 'Template');
  return template;
}

// ── Runs ────────────────────────────────────────────────────────────────

const objectOf = (value: unknown): Record<string, string> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {});

export function presentRun(row: Row, projects: Map<string, string>, names: Map<string, string>): TaskTemplateRunView {
  // A date column: YYYY-MM-DD, however the driver hands it over.
  const startDate = String(row.start_date ?? '').slice(0, 10);
  const keyDates = objectOf(row.key_dates);
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
    start_date: startDate,
    values: (row.field_values ?? {}) as Record<string, string>,
    task_ids: (row.task_ids ?? []) as string[],
    created_at: row.created_at,
    // A run recorded before key dates: its start date was its one key date.
    key_dates: Object.keys(keyDates).length ? keyDates : (startDate ? { start: startDate } : {}),
    role_members: objectOf(row.role_members),
    initiative_id: row.initiative_id ?? null,
    draft_id: (row.snapshot?.draft?.id as string | undefined) ?? null,
    drafted_by: (row.snapshot?.draft?.drafted_by as string | undefined) ?? null,
    note: row.snapshot?.draft ? `Drafted by ${(row.snapshot.draft.drafted_by_name as string | undefined) || 'an agent'}` : null,
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
export async function runnerToday(service: SupabaseClient, memberId: string): Promise<string> {
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

/** How a role was filled for a run. */
export interface RunRole {
  key: string;
  label: string;
  member_id: string | null;
  member_name: string | null;
  /** run: the run mapped it; default: the template's default member; none: nobody (its tasks keep their own assignee). */
  source: 'run' | 'default' | 'none';
}

/** The initiative a run will make. */
export interface PlannedInitiative {
  name: string;
  status: 'active';
  start_date: string | null;
  target_date: string | null;
  owner: { kind: 'member' | 'group'; id: string; name: string | null } | null;
}

/** The template as a draft saw it: what its snapshot holds. */
export interface TemplateSnapshot {
  name: string;
  description: string;
  version: number;
  fields: TemplateField[];
  items: TemplateTask[];
  key_dates: TemplateKeyDate[];
  roles: TemplateRole[];
  guidance: string;
}

/** A draft being proposed, previewed or approved: the template as it saw it, and the steps it adds and removes. */
export interface DraftSource {
  snapshot: TemplateSnapshot;
  /** Whole tasks it adds, keyed, after the template's own. */
  extra: TemplateTask[];
  /** Keys of the template's tasks (or subtasks) it leaves out. */
  removed: string[];
  /** The draft and who drafted it, for the run's note (approving). */
  id?: string;
  draftedBy?: string | null;
  draftedByName?: string | null;
}

export interface PrepareOptions {
  draft?: DraftSource;
  /**
   * Proposing a draft: role maps and added steps are not checked against the
   * caller's assign rights (whoever approves is checked instead).
   */
  proposing?: boolean;
}

/** The template's tasks with a draft's steps left out and added: dependencies on a removed step are dropped. */
export function draftItems(base: TemplateTask[], draft: Pick<DraftSource, 'extra' | 'removed'> | undefined): TemplateTask[] {
  if (!draft) return base;
  const removed = new Set(draft.removed);
  const kept = base.filter((task) => !removed.has(task.key as string)).map((task) => ({
    ...task,
    ...(task.depends_on ? { depends_on: task.depends_on.filter((key) => !removed.has(key)) } : {}),
    subtasks: (task.subtasks ?? []).filter((subtask) => !removed.has(subtask.key as string)),
  }));
  return assignTemplateKeys([...kept, ...draft.extra]);
}

/**
 * A draft's own steps against the workspace and the caller: every key it
 * removes is one of the template's, every assignee it names is active, and
 * (approving) an assignee other than the approver needs tasks.manage_all,
 * since the agent chose them, not the template's author.
 */
async function draftStepIssues(service: SupabaseClient, caller: AgentCaller, draft: DraftSource, assignsOthers: boolean, proposing: boolean): Promise<TemplateIssue[]> {
  const issues: TemplateIssue[] = [];
  const known = new Set(assignTemplateKeys(draft.snapshot.items).flatMap((task) => [task.key as string, ...(task.subtasks ?? []).map((s) => s.key as string)]));
  draft.removed.forEach((key, i) => {
    if (!known.has(key)) {
      issues.push(templateIssue(['removed_steps', i], 'unknown_step', `"${key}" is not one of the template's steps`, 'Use the key of a task or subtask in the template (get_task_template lists them).'));
    }
  });
  const named = draft.extra.flatMap((task) => [task.assignee, ...(task.subtasks ?? []).map((s) => s.assignee)]);
  const active = await activeMembers(service, named);
  draft.extra.forEach((task, i) => {
    const check = (assignee: string | null | undefined, path: (string | number)[]) => {
      if (!assignee || assignee === RUNNER) return;
      if (!active.has(assignee)) {
        issues.push(templateIssue([...path, 'assignee'], 'assignee_not_active', 'Every assignee must be an active team member', 'Use an active member id, "runner" (whoever approves it), or null.', { member_id: assignee }));
      } else if (!proposing && assignee !== caller.memberId && !assignsOthers) {
        issues.push(templateIssue([...path, 'assignee'], 'cannot_assign_others', 'You may approve an added step only when it is assigned to you',
          'Assigning tasks to others needs tasks.manage_all. Ask someone who may assign others to approve it, or reject it and ask for the step unassigned.'));
      }
    };
    check(task.assignee, ['extra_steps', i]);
    (task.subtasks ?? []).forEach((subtask, j) => check(subtask.assignee, ['extra_steps', i, 'subtasks', j]));
  });
  return issues;
}

/** A run worked out, before anything is written: what preview shows and run makes. */
export interface PreparedRun {
  row: Row;
  items: TemplateTask[];
  fields: TemplateField[];
  keyDateList: TemplateKeyDate[];
  roleList: TemplateRole[];
  projectId: string | null;
  projectName: string | null;
  keyDates: Record<string, string>;
  startDate: string | null;
  mainKey: string;
  values: Record<string, string>;
  display: Record<string, string>;
  roles: RunRole[];
  roleMembers: Record<string, string>;
  plan: PlannedTask[];
  allowed: Set<string> | null;
  notes: string[];
  errors: TemplateIssue[];
  initiative: (PlannedInitiative & { owner_member_id: string | null; owner_group_id: string | null; description: string }) | null;
  /** Who it is worked out for: their time zone says what today is (past_due). */
  callerId: string;
}

/**
 * Works a run out: the project, key dates, fill-in values, roles, the
 * initiative and every task, dated and assigned. Problems with the request
 * are collected in errors (each with its path and fix); the caller's own
 * rights (tasks.create, reaching the project) are refused at once.
 */
export async function prepareRun(service: SupabaseClient, caller: AgentCaller, templateId: string, input: RunTaskTemplateInput, options: PrepareOptions = {}): Promise<PreparedRun> {
  const current = await loadTemplateRow(service, caller, templateId);
  // A draft plans from the template as it saw it; the project lock and access are today's.
  const snapshot = options.draft?.snapshot;
  const row: Row = snapshot ? {
    ...current, name: snapshot.name, description: snapshot.description, version: snapshot.version, fields: snapshot.fields,
    items: snapshot.items, key_dates: snapshot.key_dates, roles: snapshot.roles, guidance: snapshot.guidance,
  } : current;
  if (!canRunTemplates(caller)) {
    throw forbidden('Using a template creates tasks, which needs tasks.create', {
      reason: 'missing_permission', needs: 'tasks.create', hint: 'Ask an Owner to grant you Create tasks.',
    });
  }
  const errors: TemplateIssue[] = [];
  const notes: string[] = [];

  // The project: a project's template creates only there.
  const lockedTo = (current.project_id as string | null) ?? null;
  if (lockedTo && input.project_id && input.project_id !== lockedTo) {
    errors.push(templateIssue(['project_id'], 'locked_to_project', 'This template belongs to another project and always creates there', 'Leave project_id out, or use the template\'s own project.', { project_id: lockedTo }));
  }
  const projectId = lockedTo ?? input.project_id ?? null;
  let projectName: string | null = null;
  if (!projectId) {
    errors.push(templateIssue(['project_id'], 'project_required', 'Pick the project the tasks go in', 'Send project_id: a project you can open.'));
  } else {
    const { data: project, error: projectError } = await service.from('projects').select('id, name').eq('id', projectId).is('deleted_at', null).maybeSingle();
    if (projectError) throw projectError;
    if (!project) throw notFound('Project');
    if (!accessAllowsProject(caller.access, projectId, callerChannel(caller))) {
      throw forbidden('Project scope denied', { reason: 'project_scope', project_id: projectId, hint: 'You can use templates only in projects you can open.' });
    }
    projectName = (project as { name: string }).name;
  }

  // Key dates: one date each; "start" defaults to today.
  const keyDateList = keyDatesOfRow(row);
  const known = new Set(keyDateList.map((keyDate) => keyDate.key));
  const given: Record<string, string> = { ...(input.key_dates ?? {}) };
  if (input.start_date) {
    if (!known.has('start')) {
      errors.push(templateIssue(['start_date'], 'unknown_key_date', 'This template has no start date',
        `Send key_dates instead: ${keyDateList.map((keyDate) => `${keyDate.key} (${keyDate.label})`).join(', ')}.`));
    } else if (given.start && given.start !== input.start_date) {
      errors.push(templateIssue(['start_date'], 'invalid_date', 'start_date and key_dates.start differ', 'Send the start date once.'));
    } else given.start = input.start_date;
  }
  const keyDates: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    if (!known.has(key)) {
      errors.push(templateIssue(['key_dates', key], 'unknown_key_date', `"${key}" is not one of this template's key dates`, `Use: ${[...known].join(', ')}.`));
    } else if (!isCalendarDate(value)) {
      errors.push(templateIssue(key === 'start' && input.start_date && !input.key_dates?.start ? ['start_date'] : ['key_dates', key], 'invalid_date', `${value} is not a real date`, 'Use a real calendar date, YYYY-MM-DD.'));
    } else keyDates[key] = value;
  }
  for (const keyDate of keyDateList) {
    if (keyDates[keyDate.key] || given[keyDate.key]) continue;
    if (keyDate.key === 'start') keyDates.start = await runnerToday(service, caller.memberId);
    else errors.push(templateIssue(['key_dates', keyDate.key], 'missing_key_date', `Set the ${keyDate.label}`, `Send key_dates: { "${keyDate.key}": "YYYY-MM-DD" }.`));
  }
  const startDate = keyDates.start ?? keyDates[keyDateList[0].key] ?? null;
  const mainKey = mainKeyDate(keyDateList).key;

  // Fill-in values by type.
  const fields = fieldsOf(row);
  const values = Object.fromEntries(fields.map((field) => [field.key, (input.values?.[field.key] ?? '').trim()]));
  for (const field of missingValues(fields, values)) {
    errors.push(templateIssue(['values', field.key], 'missing_values', `Fill in ${field.label}.`, `Send values: { "${field.key}": "..." }.`, { field: field.key }));
  }
  const memberValues = await activeMembers(service, fields.filter((field) => field.type === 'member').map((field) => values[field.key]));
  const display: Record<string, string> = { ...values };
  for (const field of fields) {
    const value = values[field.key];
    if (!value) continue;
    if (field.type === 'date' && !isCalendarDate(value)) {
      errors.push(templateIssue(['values', field.key], 'invalid_value', `${field.label} is not a real date`, 'Use YYYY-MM-DD.'));
    } else if (field.type === 'choice' && !(field.options ?? []).includes(value)) {
      errors.push(templateIssue(['values', field.key], 'invalid_value', `${field.label} is not one of its options`, `Use one of: ${(field.options ?? []).join(', ')}.`));
    } else if (field.type === 'member') {
      const name = memberValues.get(value);
      if (!name) errors.push(templateIssue(['values', field.key], 'member_not_active', `${field.label} must be an active team member`, 'Use an active member id.'));
      else display[field.key] = name;
    }
  }

  // Roles: the run's map, else the template's default member, else nobody.
  const roleList = rolesOf(row);
  const roleKeys = new Set(roleList.map((role) => role.key));
  const asked = input.roles ?? {};
  for (const key of Object.keys(asked)) {
    if (!roleKeys.has(key)) {
      errors.push(templateIssue(['roles', key], 'unknown_role', `"${key}" is not one of this template's roles`, roleKeys.size ? `Use: ${[...roleKeys].join(', ')}.` : 'This template has no roles.'));
    }
  }
  const askedIds = Object.values(asked).filter((value): value is string => !!value && value !== RUNNER);
  const active = await activeMembers(service, [...askedIds, ...roleList.map((role) => role.default_member_id), caller.memberId]);
  const assignsOthers = callerHolds(caller, 'tasks.manage_all');
  const roleMembers: Record<string, string> = {};
  const roles: RunRole[] = roleList.map((role) => {
    const value = Object.prototype.hasOwnProperty.call(asked, role.key) ? asked[role.key] : undefined;
    let memberId: string | null = null;
    let source: RunRole['source'] = 'none';
    if (value !== undefined) {
      source = value === null ? 'none' : 'run';
      memberId = value === RUNNER ? caller.memberId : value;
      if (memberId && !active.has(memberId)) {
        errors.push(templateIssue(['roles', role.key], 'member_not_active', `${role.label} must go to an active team member`, 'Use an active member id (a person or an agent), "runner", or null.'));
        memberId = null;
      } else if (memberId && memberId !== caller.memberId && !assignsOthers && !options.proposing) {
        errors.push(templateIssue(['roles', role.key], 'cannot_assign_others', `You may assign ${role.label} only to yourself`,
          'Assigning tasks to others needs tasks.manage_all. Map the role to "runner", leave it to its default member, or ask someone who may assign others to run it.'));
        memberId = null;
      }
    } else if (role.default_member_id) {
      // Chosen by the template's author: stands whatever the runner may assign.
      if (active.has(role.default_member_id)) {
        memberId = role.default_member_id;
        source = 'default';
      } else notes.push(`The default member for ${role.label} is no longer active, so its tasks keep their own assignee.`);
    }
    if (!memberId && source !== 'none') source = 'none';
    if (!memberId && role.required) {
      if (!errors.some((issue) => issue.path === `roles.${role.key}`)) {
        errors.push(templateIssue(['roles', role.key], 'role_unmapped', `${role.label} needs someone`, `Send roles: { "${role.key}": "<member id>" } (a person or an agent), or "runner".`));
      }
    }
    if (memberId) roleMembers[role.key] = memberId;
    return { key: role.key, label: role.label, member_id: memberId, member_name: memberId ? active.get(memberId) ?? null : null, source };
  });

  // The initiative: only when asked (off by default, so existing callers see
  // no change), named from the run, targeting the main key date.
  let initiative: PreparedRun['initiative'] = null;
  if (input.initiative && input.create_initiative !== true) {
    errors.push(templateIssue(['initiative'], 'invalid_value', 'initiative is used only when the run makes one',
      'Send create_initiative: true with it, or leave initiative out.'));
  }
  if (input.create_initiative === true) {
    const asks = input.initiative ?? {};
    const owners = [asks.owner_role, asks.owner_member_id, asks.owner_group_id].filter(Boolean);
    let ownerMember: string | null = null;
    let ownerGroup: string | null = null;
    let ownerName: string | null = null;
    if (owners.length > 1) {
      errors.push(templateIssue(['initiative'], 'invalid_value', 'Name one owner at most', 'Send one of owner_role, owner_member_id or owner_group_id.'));
    } else if (asks.owner_role) {
      if (!TEMPLATE_FIELD_KEY.test(asks.owner_role) || !roleKeys.has(asks.owner_role)) {
        errors.push(templateIssue(['initiative', 'owner_role'], 'unknown_role', `"${asks.owner_role}" is not one of this template's roles`, roleKeys.size ? `Use: ${[...roleKeys].join(', ')}.` : 'This template has no roles.'));
      } else if (!roleMembers[asks.owner_role]) {
        errors.push(templateIssue(['initiative', 'owner_role'], 'role_unmapped', 'The owner role has nobody mapped to it', `Map roles.${asks.owner_role} too, or name owner_member_id.`));
      } else {
        ownerMember = roleMembers[asks.owner_role];
        ownerName = active.get(ownerMember) ?? null;
      }
    } else if (asks.owner_member_id) {
      const found = await activeMembers(service, [asks.owner_member_id]);
      if (!found.has(asks.owner_member_id)) errors.push(templateIssue(['initiative', 'owner_member_id'], 'owner_not_found', 'The owner must be an active team member', 'Use an active member id.'));
      else { ownerMember = asks.owner_member_id; ownerName = found.get(asks.owner_member_id) ?? null; }
    } else if (asks.owner_group_id) {
      const { data, error } = await service.from('groups').select('id, name').eq('id', asks.owner_group_id).is('deleted_at', null).maybeSingle();
      if (error) throw error;
      if (!data) errors.push(templateIssue(['initiative', 'owner_group_id'], 'owner_not_found', 'The owner group is not there or is in Trash', 'Use a live group id.'));
      else { ownerGroup = asks.owner_group_id; ownerName = (data as Row).name ?? null; }
    } else {
      ownerMember = caller.memberId;
      ownerName = active.get(caller.memberId) ?? null;
    }
    const dates = Object.values(keyDates).sort();
    const shown = Object.values(display).filter(Boolean);
    const target = keyDates[mainKey] ?? null;
    const name = (asks.name ?? (shown.length ? `${row.name}: ${shown.join(', ')}` : `${row.name}${target ? ` (${target})` : ''}`)).slice(0, 120).trim();
    initiative = {
      name,
      status: 'active',
      start_date: dates[0] ?? null,
      target_date: target,
      owner: ownerMember ? { kind: 'member', id: ownerMember, name: ownerName } : ownerGroup ? { kind: 'group', id: ownerGroup, name: ownerName } : null,
      owner_member_id: ownerMember,
      owner_group_id: ownerGroup,
      description: (row.description ?? '').slice(0, 5000),
    };
  }

  const items = draftItems(itemsOf(row), options.draft);
  if (options.draft) errors.push(...await draftStepIssues(service, caller, options.draft, assignsOthers, !!options.proposing));
  const plan = planRun(items, {
    keyDates, defaultAnchor: keyDateList[0].key, values: display, runnerId: caller.memberId, roleMembers,
  });
  let allowed: Set<string> | null = null;
  if (projectId && projectName) {
    const resolved = await resolveAssignees(service, plan, projectId, projectName);
    allowed = resolved.allowed;
    notes.push(...resolved.notes);
  }
  return {
    row, items, fields, keyDateList, roleList, projectId, projectName, keyDates, startDate, mainKey, values, display, roles, roleMembers,
    plan, allowed, notes, errors, initiative, callerId: caller.memberId,
  };
}

/** A planned task as preview shows it: its key, date, assignee (after reach) and what it waits on. */
function previewTask(task: Omit<PlannedTask, 'subtasks'>, allowed: Set<string> | null, names: Map<string, string>) {
  const assignee = task.assignee_id && (!allowed || allowed.has(task.assignee_id)) ? task.assignee_id : null;
  return {
    key: task.key ?? null,
    title: task.title,
    description: task.description,
    priority: task.priority,
    tags: task.tags,
    due_date: task.due_date,
    anchor: task.anchor ?? null,
    due_in_days: task.due_in_days ?? null,
    role: task.role ?? null,
    assignee_id: assignee,
    assignee_name: assignee ? names.get(assignee) ?? null : null,
  };
}

/** What a preview answers: exactly what the run would make, or every reason it would not. */
export interface TemplateRunPreview {
  ok: boolean;
  errors: Omit<TemplateIssue, 'segments'>[];
  template: { id: string; name: string; version: number; guidance: string };
  project: { id: string; name: string } | null;
  key_dates: Record<string, string>;
  main_key_date: string;
  roles: RunRole[];
  values: Record<string, string>;
  tasks: (ReturnType<typeof previewTask> & { depends_on: string[]; subtasks: ReturnType<typeof previewTask>[] })[];
  dependencies: { task: string; waits_on: string }[];
  initiative: PlannedInitiative | null;
  task_count: number;
  notes: string[];
  /** Every task and subtask the plan dates before today in the caller's time zone, in plan order (a note per task on screen). */
  past_due: TemplatePastDue[];
}

/**
 * A dry run: the exact dated, assigned task list, dependencies and
 * initiative a run with this input would make. Writes nothing. An agent's
 * rules (paused, approval) are checked only by the run itself.
 */
export async function previewTemplateRun(service: SupabaseClient, caller: AgentCaller, templateId: string, input: RunTaskTemplateInput): Promise<TemplateRunPreview> {
  return previewOfPrepared(service, await prepareRun(service, caller, templateId, input));
}

/** The preview of a run already worked out (prepareRun). */
export async function previewOfPrepared(service: SupabaseClient, prepared: PreparedRun): Promise<TemplateRunPreview> {
  const [names, today] = await Promise.all([
    memberNames(service, prepared.plan.flatMap((task) => [task.assignee_id, ...task.subtasks.map((s) => s.assignee_id)])),
    runnerToday(service, prepared.callerId),
  ]);
  const tasks = prepared.plan.map((task) => ({
    ...previewTask(task, prepared.allowed, names),
    depends_on: task.depends_on ?? [],
    subtasks: task.subtasks.map((subtask) => previewTask(subtask, prepared.allowed, names)),
  }));
  return {
    ok: prepared.errors.length === 0,
    errors: publicIssues(prepared.errors),
    template: { id: prepared.row.id, name: prepared.row.name, version: prepared.row.version, guidance: prepared.row.guidance ?? '' },
    project: prepared.projectId && prepared.projectName ? { id: prepared.projectId, name: prepared.projectName } : null,
    key_dates: prepared.keyDates,
    main_key_date: prepared.mainKey,
    roles: prepared.roles,
    values: prepared.display,
    tasks,
    dependencies: tasks.flatMap((task) => task.depends_on.map((waitsOn) => ({ task: task.key as string, waits_on: waitsOn }))),
    initiative: prepared.initiative ? {
      name: prepared.initiative.name, status: prepared.initiative.status, start_date: prepared.initiative.start_date,
      target_date: prepared.initiative.target_date, owner: prepared.initiative.owner,
    } : null,
    task_count: taskCount(prepared.items),
    notes: prepared.notes,
    past_due: pastDueOf(tasks, today),
  };
}

export interface CreateRunOptions {
  /** The schedule that runs it (schedules, later). */
  scheduleId?: string | null;
  /** The draft a person approved: planned from its snapshot and steps, noted as drafted by its proposer. */
  draft?: DraftSource;
}

/**
 * Uses a template: the one way a run is made (by hand, API, MCP, and later
 * reflow, drafts and schedules). The run's initiative first (when asked),
 * then every task (and subtask) through the task service (save_task), then
 * dependencies, then the run and its task links in one transaction. via says
 * where the use came from. If anything fails, the tasks and the initiative
 * go to Trash and no run is recorded. A 200-task playbook is about 70 round
 * trips in a row.
 */
export async function createTemplateRun(
  service: SupabaseClient,
  caller: AgentCaller,
  templateId: string,
  input: RunTaskTemplateInput,
  via: TemplateRunVia,
  options: CreateRunOptions = {},
): Promise<TaskTemplateRunResult> {
  const prepared = await prepareRun(service, caller, templateId, input, { draft: options.draft });
  // The rules an agent runs under apply as for any task it creates.
  await requireAssistantSwitch(service, caller.memberId, caller.access, 'create_tasks');
  if (prepared.projectId) assertProjectWritable(prepared.projectId);
  const member = await loadMemberRules(service, caller.memberId);
  if (member.isAgent && member.rules.agent_create_policy === 'approval') {
    throw forbidden(`${member.name}'s rules need someone to approve its new tasks, so it cannot use templates`, {
      reason: 'needs_approval', hint: 'Suggest the tasks instead, or ask an owner to change its rules.',
    });
  }
  if (prepared.errors.length) {
    throw templateErrors(prepared.errors, prepared.errors[0].code === 'cannot_assign_others' ? 403 : 422);
  }
  const { row, plan, projectId, projectName } = prepared;
  if (!projectId || !projectName || !prepared.startDate) throw templateErrors([templateIssue(['project_id'], 'project_required', 'Pick the project the tasks go in', 'Send project_id.')]);
  const allowed = prepared.allowed ?? new Set<string>();

  // The template's author (or the runner, within their rights) chose who
  // does each task; nobody named is nobody, never the runner. Everything
  // createTaskAs checks per task was checked once above, so each task is one
  // save_task call, the same one every task goes through: activity, task
  // events and task.created webhooks fire as for any task.
  const draftedBy = options.draft ? options.draft.draftedByName || 'an agent' : null;
  const sourceNote = `From the template "${row.name}"${draftedBy ? `, drafted by ${draftedBy}` : ''}`.slice(0, 200);
  type Saved = Awaited<ReturnType<typeof insertTask>>;
  let initiative: TemplateRunInitiative | null = null;
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
      // A subtask takes its parent's initiative in the database.
      ...(initiative && !parent ? { initiative_id: initiative.id } : {}),
      ...(parent ? { parent_task_id: parent.id, sort_order: parent.order } : {}),
    } as Parameters<typeof insertTask>[1],
    task.assignee_id && allowed.has(task.assignee_id) ? [task.assignee_id] : [],
  ).catch((error: unknown) => { throw subtaskRuleError(error); });

  const parents: Saved[] = [];
  const subtasks = new Map<string, Saved[]>();
  let runId: string;
  let created: Saved[];
  try {
    if (prepared.initiative) {
      const made = await createInitiative(service, caller, projectId, {
        name: prepared.initiative.name,
        description: prepared.initiative.description,
        status: 'active',
        start_date: prepared.initiative.start_date,
        target_date: prepared.initiative.target_date,
        ...(prepared.initiative.owner_member_id ? { owner_member_id: prepared.initiative.owner_member_id } : {}),
        ...(prepared.initiative.owner_group_id ? { owner_group_id: prepared.initiative.owner_group_id } : {}),
      });
      initiative = {
        id: made.id, project_id: made.project_id, name: made.name, status: made.status, start_date: made.start_date,
        target_date: made.target_date, owner_member_id: made.owner_member_id, owner_group_id: made.owner_group_id,
      };
    }
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
    // Dependencies between top-level tasks, as real task dependencies.
    const taskByKey = new Map(plan.map((task, i) => [task.key as string, parents[i].id]));
    const dependencyRows = plan.flatMap((task, i) => (task.depends_on ?? [])
      .filter((key) => taskByKey.has(key))
      .map((key) => ({ task_id: parents[i].id, blocked_by_task_id: taskByKey.get(key) as string })));
    if (dependencyRows.length) {
      const { error } = await service.from('task_dependencies').insert(dependencyRows);
      if (error) throw error;
    }
    // Each subtask after its parent, in their order; each with the item it came from.
    const links: { task_id: string; item_key: string; planned_due_date: string | null }[] = [];
    created = parents.flatMap((parent, i) => {
      const kids = (subtasks.get(parent.id) ?? []).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      links.push({ task_id: parent.id, item_key: plan[i].key as string, planned_due_date: plan[i].due_date });
      kids.forEach((kid, j) => links.push({ task_id: kid.id, item_key: plan[i].subtasks[j]?.key as string, planned_due_date: plan[i].subtasks[j]?.due_date ?? null }));
      return [parent, ...kids];
    });
    const { data: recordedId, error: runError } = await service.rpc('record_task_template_run', {
      p_run: {
        template_id: row.id,
        template_version: row.version,
        snapshot: {
          name: row.name, description: row.description ?? '', fields: prepared.fields, items: prepared.items,
          key_dates: prepared.keyDateList, roles: prepared.roleList, guidance: row.guidance ?? '',
          ...(options.draft?.id ? { draft: { id: options.draft.id, drafted_by: options.draft.draftedBy ?? null, drafted_by_name: options.draft.draftedByName ?? null } } : {}),
        },
        project_id: projectId,
        run_by: caller.memberId,
        via,
        schedule_id: options.scheduleId ?? null,
        start_date: prepared.startDate,
        field_values: prepared.values,
        task_ids: created.map((task) => task.id),
        key_dates: prepared.keyDates,
        role_members: prepared.roleMembers,
        initiative_id: initiative?.id ?? null,
      },
      p_tasks: links,
    });
    if (runError) fail(runError);
    runId = recordedId as string;
  } catch (error) {
    // Nothing half made, and nothing a retry would double: the tasks
    // already created (their subtasks go with them) and the initiative go to Trash.
    await Promise.all(parents.map((parent) => moveToTrash(service, 'tasks', parent.id, caller.memberId).catch((trashError: unknown) => {
      console.error('[task-templates] could not move a partly made task to Trash', parent.id, trashError);
    })));
    if (initiative) {
      await moveToTrash(service, 'initiatives', initiative.id, caller.memberId).catch((trashError: unknown) => {
        console.error('[task-templates] could not move a partly made initiative to Trash', initiative?.id, trashError);
      });
    }
    throw error;
  }
  // Recorded: from here nothing is rolled back. A failed read is an error to
  // retry reading, never a reason to send a recorded run's tasks to Trash.
  const [{ data: run, error: readError }, names] = await Promise.all([
    service.from('task_template_runs').select(RUN_COLUMNS).eq('id', runId).single(),
    memberNames(service, [caller.memberId]),
  ]);
  if (readError) fail(readError);
  if (options.draft && initiative) {
    // The initiative says where it came from. A note that cannot be written never undoes a recorded run.
    const { error: noteError } = await service.from('initiative_entries').insert({
      initiative_id: initiative.id, project_id: projectId, kind: 'note', title: `Drafted by ${draftedBy}`.slice(0, 200),
      body: `Made from a draft of the template "${row.name}", approved by ${names.get(caller.memberId) ?? 'a person'}.`.slice(0, 5000),
      created_by: caller.memberId,
    });
    if (noteError) console.error('[task-templates] could not note the draft on the initiative', initiative.id, noteError);
  }
  return {
    run: presentRun(run as Row, new Map([[projectId, projectName]]), names),
    tasks: created as unknown as Row[],
    notes: prepared.notes,
    initiative,
  };
}

/** Uses a template by hand, over the API or MCP (createTemplateRun). */
export function runTemplate(
  service: SupabaseClient,
  caller: AgentCaller,
  templateId: string,
  input: RunTaskTemplateInput,
  via: Exclude<TemplateRunVia, 'schedule'>,
): Promise<TaskTemplateRunResult> {
  return createTemplateRun(service, caller, templateId, input, via);
}
