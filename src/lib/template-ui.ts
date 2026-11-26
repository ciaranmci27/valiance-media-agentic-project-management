import type { AccessContext } from '@/lib/access-control';
import { canAccessProject, hasPermission } from '@/lib/access-control';
import type { RunRole, TemplateRunPreview } from '@/lib/api/task-templates';
import type { TemplateDraftDetail, TemplateDraftPreview, TemplateDraftView } from '@/lib/api/template-drafts';
import type { ReflowKept, ReflowResult, ReflowTask, ReflowWarning } from '@/lib/api/template-reflow';
import {
  assignTemplateKeys, issuesFromZod, keyDatesOf, keyFromLabel, mainKeyDate, missingValues, pastDueOf, planRun, RUNNER, taskCount,
  templateDocumentSchema, templateIssues, type PlannedTask, type RunTaskTemplateInput, type TaskTemplateSummary, type TaskTemplateView,
  type TemplateKeyDate, type TemplateTask,
} from '@/lib/task-templates';
import type { Task } from '@/lib/types';

/**
 * What the template screens share beyond the template rules themselves
 * (lib/task-templates): who may write where, the plain summaries a row
 * shows, the due date control's parts, keys from labels, and the demo's
 * stand-ins for the validate and preview routes (the same rules, run here).
 * Client-safe and pure.
 */

export type { TemplateRunPreview, RunRole, TemplateDraftDetail, TemplateDraftPreview, TemplateDraftView, ReflowKept, ReflowResult, ReflowTask, ReflowWarning };

/** One problem as the screens show it: the server's issue without its segments. */
export interface ScreenIssue {
  path: string;
  code: string;
  message: string;
  cycle?: string[];
}

// ── Who may write where (the server's canWriteTemplate, read from access) ─

/** May write a template in this scope: company-wide needs Manage templates; a project's, the project and Manage projects or Manage templates. */
export function canWriteTemplateIn(access: AccessContext | null | undefined, projectId: string | null): boolean {
  const manages = hasPermission(access, 'templates.manage');
  if (!projectId) return manages;
  return canAccessProject(access, projectId) && (manages || hasPermission(access, 'projects.manage'));
}

/** May write some template: company-wide, or a project's own. */
export function canWriteSomeTemplate(access: AccessContext | null | undefined): boolean {
  return hasPermission(access, 'templates.manage') || hasPermission(access, 'projects.manage');
}

/** Whether the reader may change this one: the server says (can_edit); older answers are read from access. */
export function canEditTemplate(access: AccessContext | null | undefined, template: Pick<TaskTemplateSummary, 'project_id' | 'can_edit'>): boolean {
  return template.can_edit ?? canWriteTemplateIn(access, template.project_id);
}

// ── Plain summaries ───────────────────────────────────────────────────────

/** "Kickoff, Launch date (main)", or "Start date" for a template without its own. */
export function keyDatesSummary(template: Pick<TaskTemplateSummary, 'key_dates'>): string {
  const list = keyDatesOf(template.key_dates);
  const main = mainKeyDate(list).key;
  if (list.length === 1) return list[0].label;
  return list.map((keyDate) => (keyDate.key === main ? `${keyDate.label} (main)` : keyDate.label)).join(', ');
}

/** "Designer, Copywriter", or null without roles. */
export function rolesSummary(template: Pick<TaskTemplateSummary, 'roles'>): string | null {
  const roles = template.roles ?? [];
  return roles.length ? roles.map((role) => role.label).join(', ') : null;
}

// ── The due date control: a count, before or after, and a key date ────────

export type DueWhen = 'none' | 'on' | 'before' | 'after';

/** -3 reads { when: 'before', count: 3 }; null reads 'none'. */
export function duePartsOf(days: number | null | undefined): { when: DueWhen; count: number } {
  if (days === null || days === undefined) return { when: 'none', count: 1 };
  if (days === 0) return { when: 'on', count: 1 };
  return { when: days < 0 ? 'before' : 'after', count: Math.abs(days) };
}

/** The days from the key date that the parts mean. */
export function daysOfParts(when: DueWhen, count: number): number | null {
  if (when === 'none') return null;
  if (when === 'on') return 0;
  const n = Math.max(1, Math.round(Math.abs(count) || 1));
  return when === 'before' ? -n : n;
}

// ── Keys ──────────────────────────────────────────────────────────────────

/** A key from a label, not yet taken: "Launch date" reads launch_date, then launch_date_2. */
export function uniqueKey(label: string, taken: ReadonlySet<string>, fallback: string): string {
  const base = keyFromLabel(label) || fallback;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 36)}_${n}`;
  return key;
}

/** The next free task key: t1, t2, ... (stable once given, so a dependency on it survives reordering). */
export function freshItemKey(taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`t${n}`)) n++;
  return `t${n}`;
}

// ── The demo's stand-ins for the routes ──────────────────────────────────

/** The template rules on a whole template, as validate checks them (without the workspace checks). */
export function localTemplateIssues(document: unknown): ScreenIssue[] {
  const shape = templateDocumentSchema.safeParse(document);
  const issues = [...(shape.success ? [] : issuesFromZod(shape.error)), ...templateIssues(document)];
  return issues.map(({ path, code, message, cycle }) => ({ path, code, message, ...(cycle ? { cycle } : {}) }));
}

/**
 * A preview worked out here, for the demo (no server): the same plan the run
 * makes, with names from the team list, and the problems a run would refuse.
 */
export function localRunPreview(template: TaskTemplateView, input: RunTaskTemplateInput, context: {
  runnerId: string | null;
  today: string;
  projectName: string | null;
  nameOf: (memberId: string) => string | null;
}): TemplateRunPreview {
  const errors: ScreenIssue[] = [];
  const keyDateList = keyDatesOf(template.key_dates);
  const keyDates: Record<string, string> = {};
  for (const keyDate of keyDateList) {
    const given = input.key_dates?.[keyDate.key] ?? (keyDate.key === 'start' ? input.start_date : undefined);
    if (given) keyDates[keyDate.key] = given;
    else if (keyDate.key === 'start') keyDates.start = context.today;
    else errors.push({ path: `key_dates.${keyDate.key}`, code: 'missing_key_date', message: `Set the ${keyDate.label}` });
  }
  const values = Object.fromEntries(template.fields.map((field) => [field.key, (input.values?.[field.key] ?? '').trim()]));
  for (const field of missingValues(template.fields, values)) {
    errors.push({ path: `values.${field.key}`, code: 'missing_values', message: `Fill in ${field.label}.` });
  }
  const display = { ...values };
  for (const field of template.fields) {
    if (field.type === 'member' && values[field.key]) display[field.key] = context.nameOf(values[field.key]) ?? values[field.key];
  }
  const roleMembers: Record<string, string> = {};
  const roles: RunRole[] = (template.roles ?? []).map((role) => {
    const asked = input.roles && Object.prototype.hasOwnProperty.call(input.roles, role.key) ? input.roles[role.key] : undefined;
    const memberId = asked === undefined ? role.default_member_id ?? null : asked === RUNNER ? context.runnerId : asked;
    const source: RunRole['source'] = !memberId ? 'none' : asked === undefined ? 'default' : 'run';
    if (memberId) roleMembers[role.key] = memberId;
    else if (role.required) errors.push({ path: `roles.${role.key}`, code: 'role_unmapped', message: `${role.label} needs someone` });
    return { key: role.key, label: role.label, member_id: memberId, member_name: memberId ? context.nameOf(memberId) : null, source };
  });
  const plan = planRun(template.items, { keyDates, defaultAnchor: keyDateList[0].key, values: display, runnerId: context.runnerId, roleMembers });
  const view = (task: Omit<PlannedTask, 'subtasks'>) => ({
    key: task.key ?? null, title: task.title, description: task.description, priority: task.priority, tags: task.tags,
    due_date: task.due_date, anchor: task.anchor ?? null, due_in_days: task.due_in_days ?? null, role: task.role ?? null,
    assignee_id: task.assignee_id, assignee_name: task.assignee_id ? context.nameOf(task.assignee_id) : null,
  });
  const tasks = plan.map((task) => ({ ...view(task), depends_on: task.depends_on ?? [], subtasks: task.subtasks.map(view) }));
  const mainKey = mainKeyDate(keyDateList).key;
  let initiative: TemplateRunPreview['initiative'] = null;
  if (input.create_initiative) {
    const asks = input.initiative ?? {};
    const ownerId = asks.owner_role ? roleMembers[asks.owner_role] ?? null : asks.owner_member_id ?? context.runnerId;
    const shown = Object.values(display).filter(Boolean);
    const target = keyDates[mainKey] ?? null;
    initiative = {
      name: (asks.name ?? (shown.length ? `${template.name}: ${shown.join(', ')}` : `${template.name}${target ? ` (${target})` : ''}`)).slice(0, 120),
      status: 'active',
      start_date: Object.values(keyDates).sort()[0] ?? null,
      target_date: target,
      owner: ownerId ? { kind: 'member', id: ownerId, name: context.nameOf(ownerId) } : null,
    };
  }
  return {
    ok: errors.length === 0,
    errors: errors.map((issue) => ({ ...issue, hint: '' })) as TemplateRunPreview['errors'],
    template: { id: template.id, name: template.name, version: template.version, guidance: template.guidance ?? '' },
    project: input.project_id || template.project_id ? { id: (template.project_id ?? input.project_id) as string, name: context.projectName ?? 'Project' } : null,
    key_dates: keyDates,
    main_key_date: mainKey,
    roles,
    values: display,
    tasks,
    dependencies: tasks.flatMap((task) => task.depends_on.map((waitsOn) => ({ task: task.key as string, waits_on: waitsOn }))),
    initiative,
    task_count: taskCount(template.items),
    notes: [],
    past_due: pastDueOf(tasks, context.today),
  };
}

// ── Changing a live run's dates and reviewing a draft (the demo's stand-ins) ─

/** A run's task as the reflow reads it: the item it came from and the date the run planned. */
export interface RunTaskLink {
  task_id: string;
  item_key: string;
  planned_due_date: string | null;
}

const dayPart = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

/**
 * The reflow worked out here, for the demo: the same rules as the server
 * (template-reflow.ts), with every task editable. Untouched tasks move by key
 * date plus offset; a hand-changed one is kept unless included; done and
 * trashed ones are ignored; a new date before today is warned about.
 */
export function localReflow(args: {
  runId: string;
  templateId: string;
  projectId: string;
  initiative: { id: string; name: string; target_date: string | null } | null;
  items: readonly TemplateTask[];
  keyDates: readonly TemplateKeyDate[];
  from: Readonly<Record<string, string>>;
  input: { key_dates: Record<string, string>; include_task_ids?: string[]; dry_run?: boolean };
  links: readonly RunTaskLink[];
  tasks: readonly Pick<Task, 'id' | 'title' | 'status' | 'due_date' | 'parent_task_id'>[];
  today: string;
}): ReflowResult {
  const list = keyDatesOf(args.keyDates);
  const to = { ...args.from, ...args.input.key_dates };
  const mainKey = mainKeyDate(list).key;
  const plan = planRun(assignTemplateKeys([...args.items]), { keyDates: to, defaultAnchor: list[0].key, values: {}, runnerId: null, roleMembers: {} });
  const planned = new Map<string, string | null>();
  for (const task of plan) {
    planned.set(task.key as string, task.due_date);
    for (const subtask of task.subtasks) planned.set(subtask.key as string, subtask.due_date);
  }
  const include = new Set(args.input.include_task_ids ?? []);
  const byId = new Map(args.tasks.map((task) => [task.id, task]));
  const result: ReflowResult = {
    dry_run: args.input.dry_run === true, run_id: args.runId, template_id: args.templateId, project_id: args.projectId,
    initiative_id: args.initiative?.id ?? '', key_dates: { from: { ...args.from }, to }, main_key_date: mainKey,
    moved: [], kept: [], ignored: [], unchanged: 0, initiative: null, warnings: [],
  };
  for (const link of args.links) {
    if (!planned.has(link.item_key)) continue;
    const task = byId.get(link.task_id);
    if (!task) {
      result.ignored.push({ task_id: link.task_id, item_key: link.item_key, title: '', reason: 'trashed' });
      continue;
    }
    if (task.status === 'done') {
      result.ignored.push({ task_id: task.id, item_key: link.item_key, title: task.title, reason: 'done' });
      continue;
    }
    const plannedDate = dayPart(link.planned_due_date);
    const current = dayPart(task.due_date);
    const next = planned.get(link.item_key) ?? null;
    const untouched = current === plannedDate;
    const opted = include.has(task.id);
    if (next === plannedDate && (untouched || !opted)) {
      result.unchanged++;
      continue;
    }
    const entry = { task_id: task.id, item_key: link.item_key, title: task.title, parent_task_id: task.parent_task_id ?? null, from: current, to: next };
    if (untouched || opted) {
      result.moved.push(entry);
      if (next && next < args.today) {
        result.warnings.push({ code: 'date_in_past', task_id: task.id, date: next, message: `"${task.title}" would be due ${next}, before today.` });
      }
    } else {
      result.kept.push({ ...entry, reason: 'hand_changed', planned: plannedDate, can_include: true });
    }
  }
  for (const [key, value] of Object.entries(args.input.key_dates)) {
    if (value !== args.from[key] && value < args.today) {
      const label = list.find((keyDate) => keyDate.key === key)?.label ?? key;
      result.warnings.unshift({ code: 'date_in_past', key_date: key, date: value, message: `${label} is ${value}, before today.` });
    }
  }
  if (args.initiative) {
    const oldMain = args.from[mainKey] ?? null;
    const newMain = to[mainKey] ?? null;
    result.initiative = { ...args.initiative, from: oldMain, to: newMain, follows: oldMain !== newMain && args.initiative.target_date === oldMain };
  }
  return result;
}

/** A draft's steps on the template: its own left out, the draft's added at the end. */
function draftedItems(items: readonly TemplateTask[], removed: readonly string[], extra: readonly TemplateTask[]): TemplateTask[] {
  const gone = new Set(removed);
  return [
    ...assignTemplateKeys([...items]).filter((task) => !gone.has(task.key as string))
      .map((task) => ({ ...task, subtasks: (task.subtasks ?? []).filter((subtask) => !gone.has(subtask.key as string)) })),
    ...extra,
  ];
}

/**
 * A draft's preview worked out here, for the demo: the run preview of the
 * template with the draft's steps, each added one marked, the template's
 * steps it leaves out listed, and the template change since it was drafted.
 */
export function localDraftPreview(draft: TemplateDraftView, template: TaskTemplateView, context: Parameters<typeof localRunPreview>[2]): TemplateDraftPreview {
  const preview = localRunPreview({ ...template, items: draftedItems(template.items, draft.removed_steps, draft.extra_steps) }, {
    project_id: draft.project_id, key_dates: draft.key_dates, roles: draft.roles, values: draft.values,
    create_initiative: draft.create_initiative, ...(draft.initiative ? { initiative: draft.initiative } : {}),
  }, context);
  const added = new Set(draft.extra_steps.map((task) => task.key as string));
  const removed = new Set(draft.removed_steps);
  const removedTasks: TemplateDraftPreview['removed_tasks'] = [];
  for (const task of assignTemplateKeys([...template.items])) {
    if (removed.has(task.key as string)) removedTasks.push({ key: task.key as string, title: task.title, parent_key: null });
    for (const subtask of task.subtasks ?? []) {
      if (removed.has(subtask.key as string)) removedTasks.push({ key: subtask.key as string, title: subtask.title, parent_key: task.key as string });
    }
  }
  return {
    ...preview,
    tasks: preview.tasks.map((task) => ({ ...task, change: added.has(task.key as string) ? 'added' as const : null })),
    removed_tasks: removedTasks,
    template_changed_since: draft.template_changed && draft.current_template_version !== null
      ? { from_version: draft.template_version, to_version: draft.current_template_version } : null,
  };
}

/** A template title with the draft's fill-ins: "{product}" becomes its value (a removed step reads as it would have). */
export function filledTitle(title: string, values: Readonly<Record<string, string>>): string {
  return title.replace(/\{([a-z][a-z0-9_]*)\}/gi, (whole, key: string) => values[key] || whole);
}
