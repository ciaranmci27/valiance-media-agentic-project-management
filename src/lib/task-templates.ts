import { z } from 'zod';

/**
 * Task templates: one task, or a playbook (an ordered list of tasks, each
 * with optional subtasks one level deep), set up once and used again and
 * again. "Upload the payroll sheet" every month; the same twelve tasks for
 * every product launch.
 *
 * - Fill-in fields: a template declares fields ({product}, {client}) its
 *   titles and descriptions use. Using it asks for each one.
 * - Key dates: named anchors ("Start date", "Launch date"). Each task's
 *   due_in_days counts from one of them (negative is before it). A template
 *   without its own has one, "start", so due dates are days after the start
 *   date the person picks (default today).
 * - Roles: tasks assigned by role (Designer, Reviewer agent); a run maps each
 *   role to one member. Assignee otherwise: a specific person, "runner"
 *   (whoever uses it), or nobody. A mapped role wins.
 * - Dependencies: a top-level task waits on others (depends_on, by key); a
 *   run carries them into real task dependencies. No loops.
 * - Keys: every task and subtask has a stable key; the server gives one to
 *   any that has none (t1, t1.1, ...).
 * - Scope: belongs to one project (project_id), or company-wide (null).
 * - Guidance: one note on how to fill it in, for a person or an agent.
 *
 * One schema (templateDocumentSchema) is the source of truth for the
 * screens, REST and MCP; GET /api/v1/task-templates/schema publishes it as
 * JSON Schema. templateIssues() is every rule beyond the shape, each error
 * with its JSON path and a plain fix.
 *
 * Client-safe: schemas, types and the pure plan (what a use will create),
 * which the server runs and the screens preview with the same code.
 */

export const TEMPLATE_NAME_MAX = 120;
export const TEMPLATE_DESCRIPTION_MAX = 2000;
export const TEMPLATE_TITLE_MAX = 500;
export const TEMPLATE_TASK_DESCRIPTION_MAX = 10_000;
export const TEMPLATE_ITEMS_MAX = 50;
export const TEMPLATE_SUBTASKS_MAX = 30;
/** Tasks one use may create, subtasks included. */
export const TEMPLATE_TASKS_MAX = 200;
export const TEMPLATE_FIELDS_MAX = 10;
export const TEMPLATE_FIELD_LABEL_MAX = 60;
export const TEMPLATE_VALUE_MAX = 200;
export const TEMPLATE_TAGS_MAX = 20;
export const TEMPLATE_DUE_DAYS_MAX = 3650;
export const TEMPLATE_KEY_DATES_MAX = 10;
export const TEMPLATE_ROLES_MAX = 20;
export const TEMPLATE_GUIDANCE_MAX = 10_000;
export const TEMPLATE_CHOICE_OPTIONS_MAX = 20;
export const TEMPLATE_LABEL_MAX = 60;
/** What GET /api/v1/task-templates/schema calls this shape. */
export const TEMPLATE_SCHEMA_VERSION = 2;

/** The key date every template has unless it names its own. */
export const DEFAULT_KEY_DATE = { key: 'start', label: 'Start date' } as const;

export const TEMPLATE_FIELD_TYPES = ['text', 'date', 'member', 'choice'] as const;
export type TemplateFieldType = (typeof TEMPLATE_FIELD_TYPES)[number];

export const TEMPLATE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TemplatePriority = (typeof TEMPLATE_PRIORITIES)[number];

/** Whoever uses the template is assigned. */
export const RUNNER = 'runner';

export const TEMPLATE_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** A task's or subtask's key: t1, brief, launch-day, t1.2. */
export const TEMPLATE_ITEM_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** A fill-in in a title or description: {product}. */
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,39})\}/g;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const assignee = z.union([
  z.literal(RUNNER),
  z.string().regex(UUID, 'assignee is "runner", a team member id, or null'),
  z.null(),
]);

const refKey = (what: string) => z.string().regex(TEMPLATE_FIELD_KEY, `${what} is lowercase letters, numbers and underscores, starting with a letter`);
const itemKey = z.string().regex(TEMPLATE_ITEM_KEY, 'A key is lowercase letters, numbers, dots, dashes and underscores (64 at most), starting with a letter or number');

const taskFields = {
  /** Stable across edits; the server gives one when missing. depends_on names tasks by it. */
  key: itemKey.optional(),
  title: z.string().trim().min(1, 'Every task needs a title').max(TEMPLATE_TITLE_MAX, `A title is ${TEMPLATE_TITLE_MAX} characters at most`),
  description: z.string().max(TEMPLATE_TASK_DESCRIPTION_MAX, `A description is ${TEMPLATE_TASK_DESCRIPTION_MAX} characters at most`).default(''),
  priority: z.enum(TEMPLATE_PRIORITIES).default('medium'),
  tags: z.array(z.string().trim().min(1).max(50)).max(TEMPLATE_TAGS_MAX).default([]),
  assignee: assignee.default(null),
  due_in_days: z.number().int('Days are whole numbers')
    .min(-TEMPLATE_DUE_DAYS_MAX, `Days are ${TEMPLATE_DUE_DAYS_MAX} at most either side of the key date`)
    .max(TEMPLATE_DUE_DAYS_MAX, `Days are ${TEMPLATE_DUE_DAYS_MAX} at most either side of the key date`).nullable().default(null),
  /** The key date due_in_days counts from; left out, the template's first. */
  anchor: refKey('An anchor').optional(),
  /** Assigned by this role when the run maps it (the mapped member wins over assignee). */
  role: refKey('A role').nullable().optional(),
};

export const templateSubtaskSchema = z.object(taskFields).strict();
export const templateTaskSchema = z.object({
  ...taskFields,
  /** Keys of other top-level tasks this one waits on. */
  depends_on: z.array(itemKey).max(TEMPLATE_ITEMS_MAX).optional(),
  subtasks: z.array(templateSubtaskSchema).max(TEMPLATE_SUBTASKS_MAX, `A task has ${TEMPLATE_SUBTASKS_MAX} subtasks at most`).default([]),
}).strict();

export const templateFieldSchema = z.object({
  key: z.string().regex(TEMPLATE_FIELD_KEY, 'A field key is lowercase letters, numbers and underscores, starting with a letter'),
  label: z.string().trim().min(1, 'Every field needs a label').max(TEMPLATE_FIELD_LABEL_MAX),
  /** text (default), date (YYYY-MM-DD), member (a team member id; fills in their name) or choice (one of options). */
  type: z.enum(TEMPLATE_FIELD_TYPES).optional(),
  /** The values a choice field allows. */
  options: z.array(z.string().trim().min(1).max(TEMPLATE_VALUE_MAX)).max(TEMPLATE_CHOICE_OPTIONS_MAX).optional(),
  /** Default true: a run must fill it in. */
  required: z.boolean().optional(),
}).strict();

export const templateKeyDateSchema = z.object({
  key: refKey('A key date key'),
  label: z.string().trim().min(1, 'Every key date needs a label').max(TEMPLATE_LABEL_MAX),
  /** The run's initiative targets this date. At most one; left out, the first key date. */
  main: z.boolean().optional(),
}).strict();

export const templateRoleSchema = z.object({
  key: refKey('A role key'),
  label: z.string().trim().min(1, 'Every role needs a label').max(TEMPLATE_LABEL_MAX),
  /** Who gets it when a run does not say (a person or an agent). */
  default_member_id: z.string().regex(UUID, 'default_member_id is a team member id or null').nullable().optional(),
  /** A run must map it (or it has a default member). */
  required: z.boolean().optional(),
}).strict();

export type TemplateSubtask = z.infer<typeof templateSubtaskSchema>;
export type TemplateTask = z.infer<typeof templateTaskSchema>;
export type TemplateField = z.infer<typeof templateFieldSchema>;
export type TemplateAssignee = TemplateTask['assignee'];
export type TemplateKeyDate = z.infer<typeof templateKeyDateSchema>;
export type TemplateRole = z.infer<typeof templateRoleSchema>;

/** Where a template lives: one project, or the whole workspace (any project). */
export type TemplateScope = 'project' | 'workspace';
export const TEMPLATE_SCOPES = ['project', 'workspace'] as const;
export const templateScope = (projectId: string | null | undefined): TemplateScope => (projectId ? 'project' : 'workspace');

const items = z.array(templateTaskSchema).min(1, 'Add at least one task').max(TEMPLATE_ITEMS_MAX, `A template holds ${TEMPLATE_ITEMS_MAX} tasks at most`);
const fields = z.array(templateFieldSchema).max(TEMPLATE_FIELDS_MAX, `A template has ${TEMPLATE_FIELDS_MAX} fill-in fields at most`);

const keyDates = z.array(templateKeyDateSchema).min(1, 'A template has at least one key date').max(TEMPLATE_KEY_DATES_MAX, `A template has ${TEMPLATE_KEY_DATES_MAX} key dates at most`);
const roles = z.array(templateRoleSchema).max(TEMPLATE_ROLES_MAX, `A template has ${TEMPLATE_ROLES_MAX} roles at most`);
const guidance = z.string().max(TEMPLATE_GUIDANCE_MAX, `Guidance is ${TEMPLATE_GUIDANCE_MAX} characters at most`);
const templateName = z.string().trim().min(1, 'Name is required').max(TEMPLATE_NAME_MAX, `A name is ${TEMPLATE_NAME_MAX} characters at most`);
const templateDescription = z.string().trim().max(TEMPLATE_DESCRIPTION_MAX, `A description is ${TEMPLATE_DESCRIPTION_MAX} characters at most`);
const templateProject = z.string().regex(UUID, 'project_id must be a uuid').nullable();

/**
 * A whole template, its shape only: what create takes, what the schema
 * endpoint publishes, and what MCP tools show. templateIssues() holds the
 * rules that span fields (keys, anchors, roles, dependencies, fill-ins).
 */
export const templateDocumentSchema = z.object({
  name: templateName,
  description: templateDescription.default(''),
  /** The project it belongs to; null or left out: company-wide. */
  project_id: templateProject.default(null),
  /** How to fill it in and what to look at first, for a person or an agent. */
  guidance: guidance.optional(),
  /** Named anchors; left out: one, { key: "start", label: "Start date" }. */
  key_dates: keyDates.optional(),
  roles: roles.optional(),
  fields: fields.default([]),
  items,
}).strict();
export type TemplateDocumentInput = z.input<typeof templateDocumentSchema>;
export type TemplateDocument = z.infer<typeof templateDocumentSchema>;

/** A change, its shape only: send only what changes; arrays are replaced whole. */
export const templatePatchSchema = z.object({
  name: templateName.optional(),
  description: templateDescription.optional(),
  project_id: templateProject.optional(),
  guidance: guidance.optional(),
  key_dates: keyDates.optional(),
  roles: roles.optional(),
  fields: fields.optional(),
  items: items.optional(),
}).strict();
export type TemplatePatch = z.infer<typeof templatePatchSchema>;

/** The template rules beyond the shape, as zod issues (for the schemas below). */
function contentIssues(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  for (const issue of templateIssues(value)) ctx.addIssue({ code: 'custom', path: issue.segments, message: issue.message });
}

export const createTaskTemplateSchema = templateDocumentSchema.superRefine(contentIssues);
export type CreateTaskTemplateInput = z.infer<typeof createTaskTemplateSchema>;

/**
 * A change: send only what changes. fields, items, key_dates and roles are
 * replaced whole (send fields with items when the fill-ins change). The
 * server checks the change against the template it changes.
 */
export const updateTaskTemplateSchema = templatePatchSchema
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change');
export type UpdateTaskTemplateInput = z.infer<typeof updateTaskTemplateSchema>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** The initiative a run makes: its name and owner (one at most). */
export const runInitiativeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  /** The member a role maps to owns it. */
  owner_role: z.string().regex(TEMPLATE_FIELD_KEY, 'owner_role is a role key').optional(),
  owner_member_id: z.string().regex(UUID, 'owner_member_id must be a uuid').optional(),
  owner_group_id: z.string().regex(UUID, 'owner_group_id must be a uuid').optional(),
}).strict();

export const runTaskTemplateSchema = z.object({
  /** Where the tasks go. Left out for a template locked to a project. */
  project_id: z.string().regex(UUID, 'project_id must be a uuid').optional(),
  /** Due dates count from here (default: today, in the runner's time zone). */
  start_date: date.optional(),
  /** A value for every fill-in field, by key. */
  values: z.record(z.string(), z.string().trim().max(TEMPLATE_VALUE_MAX, `A value is ${TEMPLATE_VALUE_MAX} characters at most`)).default({}),
  /** A date for each key date, by key: { "launch": "2027-03-01" }. "start" defaults to today (start_date sets it too). */
  key_dates: z.record(z.string(), date).optional(),
  /** One member per role, by role key: a member id (a person or an agent), "runner" for whoever runs it, or null for nobody. */
  roles: z.record(z.string(), z.union([z.literal(RUNNER), z.string().regex(UUID, 'A role maps to a member id, "runner" or null'), z.null()])).optional(),
  /** Default false. true: the run makes an initiative named from the run, targeting the main key date, active, its tasks inside it. */
  create_initiative: z.boolean().optional(),
  initiative: runInitiativeSchema.optional(),
}).strict();
export type RunTaskTemplateInput = z.infer<typeof runTaskTemplateSchema>;

// ── Views ─────────────────────────────────────────────────────────────────

/** A template as the library lists it: everything but its tasks. */
export interface TaskTemplateSummary {
  id: string;
  name: string;
  description: string;
  /** The project it belongs to (shown and used only there), or null: company-wide. */
  project_id: string | null;
  project_name: string | null;
  /**
   * The fields below are always sent by the server (2.0.46 on); optional in
   * this type only for screens and demo data built before them.
   * scope: project (project_id set) or workspace (company-wide).
   */
  scope?: TemplateScope;
  /** Whether the reader may change it (and move it to Trash). */
  can_edit?: boolean;
  key_dates?: TemplateKeyDate[];
  roles?: TemplateRole[];
  fields: TemplateField[];
  /** Top-level tasks. */
  item_count: number;
  /** Every task a use creates, subtasks included. */
  task_count: number;
  version: number;
  run_count: number;
  last_run_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One template with its tasks. */
export interface TaskTemplateView extends TaskTemplateSummary {
  /** Every task and subtask with its key. */
  items: TemplateTask[];
  created_by_name: string | null;
  /** The template's note for whoever fills it in (always sent by the server). */
  guidance?: string;
}

/** A template as the library lists it, from the full view. */
export function templateSummary(view: TaskTemplateView): TaskTemplateSummary {
  return {
    id: view.id, name: view.name, description: view.description, project_id: view.project_id, project_name: view.project_name,
    fields: view.fields, item_count: view.item_count, task_count: view.task_count, version: view.version, run_count: view.run_count,
    last_run_at: view.last_run_at, created_by: view.created_by, created_at: view.created_at, updated_at: view.updated_at,
    ...(view.scope !== undefined ? { scope: view.scope } : {}),
    ...(view.can_edit !== undefined ? { can_edit: view.can_edit } : {}),
    ...(view.key_dates !== undefined ? { key_dates: view.key_dates } : {}),
    ...(view.roles !== undefined ? { roles: view.roles } : {}),
  };
}

export type TemplateRunVia = 'app' | 'api' | 'mcp' | 'schedule';

/** One use of a template. */
export interface TaskTemplateRunView {
  id: string;
  template_id: string;
  template_version: number;
  template_name: string;
  project_id: string;
  project_name: string | null;
  run_by: string | null;
  run_by_name: string | null;
  via: TemplateRunVia;
  schedule_id: string | null;
  start_date: string;
  values: Record<string, string>;
  task_ids: string[];
  created_at: string;
  /** Always sent by the server; optional only for screens and demo data built before them. */
  key_dates?: Record<string, string>;
  /** The member each role was assigned to. */
  role_members?: Record<string, string>;
  /** The initiative the run made, or null. */
  initiative_id?: string | null;
}

/** The initiative a run made, as the run answers it. */
export interface TemplateRunInitiative {
  id: string;
  project_id: string;
  name: string;
  status: string;
  start_date: string | null;
  target_date: string | null;
  owner_member_id: string | null;
  owner_group_id: string | null;
}

/** What a use answers: the run, the tasks it made (each subtask after its parent), and plain notes. */
export interface TaskTemplateRunResult<TTask = Record<string, unknown>> {
  run: TaskTemplateRunView;
  tasks: TTask[];
  /** Plain lines on anything left out ("Sam cannot open Acme, so ... is unassigned"). */
  notes: string[];
  /** The initiative the run made (null when it made none). Always sent by the server. */
  initiative?: TemplateRunInitiative | null;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/** The fill-ins a text uses, in order, each once. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/** Every fill-in the tasks use, titles and descriptions, subtasks included. */
export function usedPlaceholders(tasks: readonly (TemplateTask | TemplateSubtask)[]): Set<string> {
  const keys = new Set<string>();
  for (const task of tasks) {
    for (const key of [...placeholdersIn(task.title), ...placeholdersIn(task.description ?? '')]) keys.add(key);
    for (const subtask of ('subtasks' in task ? task.subtasks ?? [] : [])) {
      for (const key of [...placeholdersIn(subtask.title), ...placeholdersIn(subtask.description ?? '')]) keys.add(key);
    }
  }
  return keys;
}

/** A field's label from its key: client_name reads "Client name". */
export function labelForKey(key: string): string {
  const words = key.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A key from what a person typed: "Client name" reads client_name. Empty when nothing is left. */
export function keyFromLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/g, '')
    .slice(0, 40);
}

/**
 * The fields a template asks for, kept in step with the fill-ins its tasks
 * use: each used key keeps its label (or gets one from its key), in the
 * order first used; a field no task uses any more is dropped.
 */
export function syncFields(current: readonly TemplateField[], tasks: readonly TemplateTask[]): TemplateField[] {
  const known = new Map(current.map((field) => [field.key, field]));
  return [...usedPlaceholders(tasks)].map((key) => known.get(key) ?? { key, label: labelForKey(key) });
}

/** A text with each declared fill-in replaced by its value. Anything else stays as written. */
export function fillIn(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole));
}

/** Every task a use creates, subtasks included. */
export function taskCount(tasks: readonly TemplateTask[]): number {
  return tasks.reduce((sum, task) => sum + 1 + (task.subtasks?.length ?? 0), 0);
}

/** A date (YYYY-MM-DD) plus whole days, on the calendar (no time zone shifts). */
export function addDays(start: string, days: number): string {
  const [y, m, d] = start.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

/** Whether a string is a real calendar date (YYYY-MM-DD). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** "1 task", "Playbook, 6 tasks": what the template makes, in a few words. */
export function templateSizeLabel(count: { item_count: number; task_count: number }): string {
  if (count.task_count <= 1) return '1 task';
  if (count.item_count === 1) return `1 task, ${count.task_count - 1} subtask${count.task_count === 2 ? '' : 's'}`;
  return `Playbook, ${count.task_count} tasks`;
}

/**
 * "Due on the start date", "Due 3 days after start", "Due 2 days before
 * Launch date": a relative due date in words. anchor is the key date's
 * label (default "start").
 */
export function dueLabel(days: number | null, anchor?: string): string {
  if (days === null) return 'No due date';
  const name = anchor ?? 'start';
  if (days === 0) return anchor ? `Due on ${anchor}` : 'Due on the start date';
  const count = Math.abs(days);
  return `Due ${count} day${count === 1 ? '' : 's'} ${days > 0 ? 'after' : 'before'} ${name}`;
}

/** The fields a use left empty (a field with required false may be). */
export function missingValues(fieldsDeclared: readonly TemplateField[], values: Readonly<Record<string, string>>): TemplateField[] {
  return fieldsDeclared.filter((field) => field.required !== false && !(values[field.key] ?? '').trim());
}

/** The template's key dates: its own, or the one every template has ("start"). */
export function keyDatesOf(keyDates: readonly TemplateKeyDate[] | null | undefined): TemplateKeyDate[] {
  return keyDates && keyDates.length ? [...keyDates] : [{ ...DEFAULT_KEY_DATE }];
}

/** The key date a run's initiative targets: the one marked main, else the first. */
export function mainKeyDate(keyDates: readonly TemplateKeyDate[] | null | undefined): TemplateKeyDate {
  const list = keyDatesOf(keyDates);
  return list.find((keyDate) => keyDate.main) ?? list[0];
}

/**
 * Every task and subtask with a key: the ones given stay; the rest get one
 * from their place (t1, t2, t1.1), skipping any already taken. The same
 * items always get the same keys, so saving a template twice changes nothing.
 */
export function assignTemplateKeys(tasks: readonly TemplateTask[]): TemplateTask[] {
  const used = new Set<string>();
  for (const task of tasks) {
    if (task.key) used.add(task.key);
    for (const subtask of task.subtasks ?? []) if (subtask.key) used.add(subtask.key);
  }
  const fresh = (base: string) => {
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    return key;
  };
  return tasks.map((task, i) => {
    const key = task.key ?? fresh(`t${i + 1}`);
    return {
      ...task,
      key,
      subtasks: (task.subtasks ?? []).map((subtask, j) => ({ ...subtask, key: subtask.key ?? fresh(`${key.slice(0, 56)}.${j + 1}`) })),
    };
  });
}

/** One task a use will create. */
export interface PlannedTask {
  /** The template item it comes from. */
  key?: string;
  title: string;
  description: string;
  priority: TemplatePriority;
  tags: string[];
  /** The member to assign, or null. */
  assignee_id: string | null;
  due_date: string | null;
  /** The key date its due date counts from, and the days from it. */
  anchor?: string | null;
  due_in_days?: number | null;
  /** The role it is assigned by, when it has one. */
  role?: string | null;
  /** Keys of the top-level tasks it waits on. */
  depends_on?: string[];
  subtasks: Omit<PlannedTask, 'subtasks'>[];
}

/**
 * What a use creates: fill-ins replaced, due dates counted from their key
 * date (keyDates by key; startDate is the "start" one), a role mapped to a
 * member assigning it (else the task's own assignee), "runner" resolved to
 * whoever uses it. The server creates exactly this; the screens and the
 * preview show it before anyone clicks.
 */
export function planRun(
  tasks: readonly TemplateTask[],
  input: {
    startDate?: string;
    keyDates?: Readonly<Record<string, string>>;
    /** The key date a task without an anchor counts from (default "start"). */
    defaultAnchor?: string;
    values: Readonly<Record<string, string>>;
    runnerId: string | null;
    /** The member each role maps to (null or missing: not mapped). */
    roleMembers?: Readonly<Record<string, string | null>>;
  },
): PlannedTask[] {
  const keyDates: Record<string, string> = { ...(input.startDate ? { start: input.startDate } : {}), ...(input.keyDates ?? {}) };
  const defaultAnchor = input.defaultAnchor ?? DEFAULT_KEY_DATE.key;
  const one = (task: TemplateSubtask): Omit<PlannedTask, 'subtasks'> => {
    const anchor = task.anchor ?? defaultAnchor;
    const days = task.due_in_days ?? null;
    const base = keyDates[anchor];
    const mapped = task.role ? input.roleMembers?.[task.role] ?? null : null;
    const own = task.assignee === RUNNER ? input.runnerId : task.assignee ?? null;
    return {
      ...(task.key ? { key: task.key } : {}),
      title: fillIn(task.title, input.values).trim(),
      description: fillIn(task.description ?? '', input.values),
      priority: task.priority ?? 'medium',
      tags: [...new Set(task.tags ?? [])],
      assignee_id: mapped ?? own,
      due_date: days === null || !base ? null : addDays(base, days),
      anchor: days === null ? null : anchor,
      due_in_days: days,
      role: task.role ?? null,
    };
  };
  return tasks.map((task) => ({ ...one(task), depends_on: [...new Set(task.depends_on ?? [])], subtasks: (task.subtasks ?? []).map(one) }));
}

// ── Template rules beyond the shape ──────────────────────────────────────

/** What went wrong, as a stable code an agent can branch on. */
export type TemplateIssueCode =
  // The shape
  | 'required' | 'unknown_property' | 'invalid_value' | 'out_of_range' | 'offset_out_of_range'
  // Across fields
  | 'duplicate_key' | 'unknown_anchor' | 'unknown_role' | 'unknown_dependency' | 'dependency_not_top_level'
  | 'dependency_cycle' | 'undeclared_field' | 'too_many_tasks' | 'main_key_date' | 'choice_needs_options' | 'options_need_choice'
  // Checked against the workspace
  | 'project_not_found' | 'assignee_not_active' | 'member_not_active'
  // A run
  | 'project_required' | 'locked_to_project' | 'missing_values' | 'missing_key_date' | 'unknown_key_date' | 'invalid_date'
  | 'role_unmapped' | 'cannot_assign_others' | 'owner_not_found';

/** One error: where (a JSON path such as items[2].depends_on[0]), what and how to fix it. */
export interface TemplateIssue {
  path: string;
  code: TemplateIssueCode;
  message: string;
  hint: string;
  /** The path as segments, for code. */
  segments: (string | number)[];
  /** A dependency loop, as task keys: ["brief", "assets", "brief"]. */
  cycle?: string[];
  /** The fill-in field it is about (undeclared_field, missing_values). */
  field?: string;
  /** The member it is about (assignee_not_active). */
  member_id?: string;
  /** The project the template belongs to (locked_to_project). */
  project_id?: string;
}

/** items[2].subtasks[0].title from ['items', 2, 'subtasks', 0, 'title']. */
export function formatIssuePath(segments: readonly (string | number | symbol)[]): string {
  return segments.reduce<string>((path, segment) => (typeof segment === 'number'
    ? `${path}[${segment}]`
    : `${path}${path ? '.' : ''}${String(segment)}`), '');
}

export function templateIssue(segments: (string | number)[], code: TemplateIssueCode, message: string, hint: string, extra?: Partial<TemplateIssue>): TemplateIssue {
  return { path: formatIssuePath(segments), code, message, hint, segments, ...extra };
}

const SCHEMA_HINT = 'GET /api/v1/task-templates/schema lists every property and its rules.';
const PROPERTY_HINTS: Record<string, string> = {
  name: 'Give the template a name, 1 to 120 characters.',
  title: 'Give every task a title, 1 to 500 characters.',
  items: 'Send 1 to 50 tasks, each { title, ... }.',
  key: 'Use lowercase letters, numbers, dots, dashes and underscores, starting with a letter or number.',
  anchor: 'Use the key of one of key_dates.',
  role: 'Use the key of one of roles, or null.',
  assignee: 'Use "runner", a team member id, or null.',
  depends_on: 'List keys of other top-level tasks.',
  project_id: 'Use a project id, or null for a company-wide template.',
  priority: 'Use low, medium, high or urgent.',
  type: 'Use text, date, member or choice.',
  default_member_id: 'Use a team member id, or null.',
};

/** zod's issues as template issues, each with its path and a fix. */
export function issuesFromZod(error: z.ZodError, prefix: (string | number)[] = []): TemplateIssue[] {
  const out: TemplateIssue[] = [];
  for (const issue of error.issues) {
    const segments = [...prefix, ...issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment)))];
    const last = [...segments].reverse().find((segment) => typeof segment === 'string') as string | undefined;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        out.push(templateIssue([...segments, key], 'unknown_property', `${key} is not a property here`, `Remove it. ${SCHEMA_HINT}`));
      }
      continue;
    }
    if (last === 'due_in_days' && (issue.code === 'too_small' || issue.code === 'too_big')) {
      out.push(templateIssue(segments, 'offset_out_of_range', issue.message,
        `Use whole days from -${TEMPLATE_DUE_DAYS_MAX} to ${TEMPLATE_DUE_DAYS_MAX}: negative is before the key date, or null for no due date.`));
      continue;
    }
    const missing = issue.code === 'invalid_type' && /received undefined/.test(issue.message);
    const code: TemplateIssueCode = missing ? 'required' : issue.code === 'too_small' || issue.code === 'too_big' ? 'out_of_range' : 'invalid_value';
    out.push(templateIssue(segments, code, missing ? `${last ?? 'This'} is required` : issue.message, (last && PROPERTY_HINTS[last]) ?? SCHEMA_HINT));
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rules read an unchecked document defensively
type Loose = any;
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Every rule a template must keep beyond its shape, each error with its JSON
 * path and a plain fix: duplicate keys (fields, key dates, roles, tasks), an
 * anchor or role that is not declared, a dependency on a missing task, on a
 * subtask or in a loop, a fill-in with no field, a choice field without
 * options, two main key dates, more than 200 tasks. Reads an unchecked
 * document defensively, so shape errors and these come back together.
 * Tasks without a key are read with the keys assignTemplateKeys gives them.
 */
export function templateIssues(document: Loose): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (!document || typeof document !== 'object') return issues;

  const duplicates = (entries: Loose[], name: string, what: string) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = text(entry?.key);
      if (!key) return;
      if (seen.has(key)) issues.push(templateIssue([name, index, 'key'], 'duplicate_key', `The ${what} key "${key}" is used twice`, `Give each ${what} its own key.`));
      seen.add(key);
    });
  };

  const fields = list(document.fields);
  duplicates(fields, 'fields', 'field');
  fields.forEach((field, index) => {
    const options = list(field?.options);
    if (field?.type === 'choice' && options.length === 0) {
      issues.push(templateIssue(['fields', index, 'options'], 'choice_needs_options', `The choice field "${text(field?.key) ?? index}" has no options`, 'Add options: ["Small", "Large"], or use type text.'));
    }
    if (field?.type !== 'choice' && field?.options !== undefined) {
      issues.push(templateIssue(['fields', index, 'options'], 'options_need_choice', 'Only a choice field has options', 'Set type to choice, or remove options.'));
    }
  });

  const keyDates: Loose[] = document.key_dates === undefined || document.key_dates === null ? [{ ...DEFAULT_KEY_DATE }] : list(document.key_dates);
  duplicates(keyDates, 'key_dates', 'key date');
  let mains = 0;
  keyDates.forEach((keyDate, index) => {
    if (keyDate?.main === true && ++mains > 1) {
      issues.push(templateIssue(['key_dates', index, 'main'], 'main_key_date', 'Only one key date can be the main one', 'Set main on one key date (the initiative targets it); remove it from the others.'));
    }
  });
  const anchorKeys = keyDates.map((keyDate) => text(keyDate?.key)).filter((key): key is string => !!key);

  const roles = list(document.roles);
  duplicates(roles, 'roles', 'role');
  const roleKeys = roles.map((role) => text(role?.key)).filter((key): key is string => !!key);

  const items = list(document.items);
  // Keys as the server will store them, so a dependency on t2 reads as it will run.
  const keyed = assignTemplateKeys(items.map((item) => ({
    ...(item && typeof item === 'object' ? item : {}),
    key: text(item?.key) ?? undefined,
    subtasks: list(item?.subtasks).map((subtask) => ({ ...(subtask && typeof subtask === 'object' ? subtask : {}), key: text(subtask?.key) ?? undefined })),
  })) as TemplateTask[]);
  const seenKeys = new Map<string, string>();
  const topKeys = new Set(keyed.map((item) => item.key as string));
  const subtaskKeys = new Set(keyed.flatMap((item) => (item.subtasks ?? []).map((subtask) => subtask.key as string)));
  const declared = new Set(fields.map((field) => text(field?.key)).filter(Boolean));
  const checkTask = (raw: Loose, path: (string | number)[]) => {
    const key = text(raw?.key);
    if (key) {
      if (seenKeys.has(key)) {
        issues.push(templateIssue([...path, 'key'], 'duplicate_key', `The task key "${key}" is used twice (also at ${seenKeys.get(key)})`, 'Give every task and subtask its own key.'));
      } else seenKeys.set(key, formatIssuePath(path));
    }
    const anchor = text(raw?.anchor);
    if (anchor && anchorKeys.length && !anchorKeys.includes(anchor)) {
      issues.push(templateIssue([...path, 'anchor'], 'unknown_anchor', `"${anchor}" is not one of this template's key dates`,
        `Use one of: ${anchorKeys.join(', ')}. Or add { "key": "${anchor}", "label": "..." } to key_dates.`));
    }
    const role = text(raw?.role);
    if (role && !roleKeys.includes(role)) {
      issues.push(templateIssue([...path, 'role'], 'unknown_role', `"${role}" is not one of this template's roles`,
        roleKeys.length ? `Use one of: ${roleKeys.join(', ')}. Or add { "key": "${role}", "label": "..." } to roles.` : `Add { "key": "${role}", "label": "..." } to roles.`));
    }
    for (const property of ['title', 'description'] as const) {
      const value = text(raw?.[property]);
      if (!value) continue;
      for (const placeholder of placeholdersIn(value)) {
        if (!declared.has(placeholder)) {
          issues.push(templateIssue([...path, property], 'undeclared_field', `Declare a fill-in field for {${placeholder}}: it is used here, but no field declares it`,
            `Add { "key": "${placeholder}", "label": "${labelForKey(placeholder)}" } to fields, or remove {${placeholder}}.`, { field: placeholder }));
        }
      }
    }
  };
  items.forEach((item, i) => {
    checkTask(item, ['items', i]);
    list(item?.subtasks).forEach((subtask, j) => checkTask(subtask, ['items', i, 'subtasks', j]));
  });

  // Dependencies: top-level tasks only, every one declared, no loops.
  const edges = new Map<string, string[]>();
  items.forEach((item, i) => {
    const own = keyed[i].key as string;
    const valid: string[] = [];
    list(item?.depends_on).forEach((dependency, j) => {
      const key = text(dependency);
      if (!key) return;
      const path = ['items', i, 'depends_on', j];
      if (key === own) {
        issues.push(templateIssue(path, 'dependency_cycle', `"${own}" waits on itself`, 'Remove it from its own depends_on.', { cycle: [own, own] }));
      } else if (topKeys.has(key)) {
        valid.push(key);
      } else if (subtaskKeys.has(key)) {
        issues.push(templateIssue(path, 'dependency_not_top_level', `"${key}" is a subtask; tasks wait only on top-level tasks`, 'Depend on its parent task instead.'));
      } else {
        issues.push(templateIssue(path, 'unknown_dependency', `No task has the key "${key}"`,
          `Use the key of another top-level task (${[...topKeys].filter((k) => k !== own).slice(0, 10).join(', ') || 'there are none'}); give that task a key first if it has none.`));
      }
    });
    // A key used twice (refused above) keeps both tasks' dependencies, so a loop through either shows.
    edges.set(own, [...new Set([...(edges.get(own) ?? []), ...valid])]);
  });
  const state = new Map<string, 'open' | 'done'>();
  const reported = new Set<string>();
  const visit = (key: string, trail: string[]) => {
    state.set(key, 'open');
    for (const next of edges.get(key) ?? []) {
      if (state.get(next) === 'open') {
        const cycle = [...trail.slice(trail.indexOf(next)), next];
        const id = [...cycle.slice(0, -1)].sort().join('>');
        if (!reported.has(id)) {
          reported.add(id);
          const at = keyed.findIndex((item) => item.key === cycle[0]);
          const dependencyIndex = list(items[at]?.depends_on).indexOf(cycle[1]);
          issues.push(templateIssue(['items', at, 'depends_on', ...(dependencyIndex >= 0 ? [dependencyIndex] : [])], 'dependency_cycle',
            `These tasks wait on each other in a loop: ${cycle.join(' waits on ')}`,
            `Remove one of these dependencies: ${cycle.slice(0, -1).map((k, n) => `${k} on ${cycle[n + 1]}`).join(', ')}.`, { cycle }));
        }
      } else if (!state.has(next)) visit(next, [...trail, next]);
    }
    state.set(key, 'done');
  };
  for (const key of edges.keys()) if (!state.has(key)) visit(key, [key]);

  if (items.reduce((sum, item) => sum + 1 + list(item?.subtasks).length, 0) > TEMPLATE_TASKS_MAX) {
    issues.push(templateIssue(['items'], 'too_many_tasks', `A template makes ${TEMPLATE_TASKS_MAX} tasks at most, subtasks included`, 'Split it into two templates, or fold subtasks into their task.'));
  }
  return issues;
}

/**
 * The template's JSON Schema (draft 2020-12), from the same zod schema the
 * server checks with: what create takes, and each part an agent needs.
 */
export function templateJsonSchemas(): Record<string, unknown> {
  const json = (schema: z.ZodType) => {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    return out;
  };
  return {
    template: json(templateDocumentSchema),
    update: json(templatePatchSchema),
    run: json(runTaskTemplateSchema),
  };
}
