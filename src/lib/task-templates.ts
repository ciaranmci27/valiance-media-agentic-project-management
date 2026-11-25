import { z } from 'zod';

/**
 * Task templates: one task, or a playbook (an ordered list of tasks, each
 * with optional subtasks one level deep), set up once and used again and
 * again. "Upload the payroll sheet" every month; the same twelve tasks for
 * every product launch.
 *
 * - Fill-in fields: a template declares fields ({product}, {client}) its
 *   titles and descriptions use. Using it asks for each one.
 * - Due dates are days after the start date the person picks (default
 *   today), so a playbook lands on the calendar the same way every time.
 * - Assignee: a specific person, "runner" (whoever uses it), or nobody.
 * - Locked to a project: it shows only there and always creates there.
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

export const TEMPLATE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TemplatePriority = (typeof TEMPLATE_PRIORITIES)[number];

/** Whoever uses the template is assigned. */
export const RUNNER = 'runner';

export const TEMPLATE_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** A fill-in in a title or description: {product}. */
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,39})\}/g;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const assignee = z.union([
  z.literal(RUNNER),
  z.string().regex(UUID, 'assignee is "runner", a team member id, or null'),
  z.null(),
]);

const taskFields = {
  title: z.string().trim().min(1, 'Every task needs a title').max(TEMPLATE_TITLE_MAX, `A title is ${TEMPLATE_TITLE_MAX} characters at most`),
  description: z.string().max(TEMPLATE_TASK_DESCRIPTION_MAX, `A description is ${TEMPLATE_TASK_DESCRIPTION_MAX} characters at most`).default(''),
  priority: z.enum(TEMPLATE_PRIORITIES).default('medium'),
  tags: z.array(z.string().trim().min(1).max(50)).max(TEMPLATE_TAGS_MAX).default([]),
  assignee: assignee.default(null),
  due_in_days: z.number().int('Days are whole numbers').min(0, 'Days count from the start date: 0 or more').max(TEMPLATE_DUE_DAYS_MAX).nullable().default(null),
};

export const templateSubtaskSchema = z.object(taskFields).strict();
export const templateTaskSchema = z.object({
  ...taskFields,
  subtasks: z.array(templateSubtaskSchema).max(TEMPLATE_SUBTASKS_MAX, `A task has ${TEMPLATE_SUBTASKS_MAX} subtasks at most`).default([]),
}).strict();

export const templateFieldSchema = z.object({
  key: z.string().regex(TEMPLATE_FIELD_KEY, 'A field key is lowercase letters, numbers and underscores, starting with a letter'),
  label: z.string().trim().min(1, 'Every field needs a label').max(TEMPLATE_FIELD_LABEL_MAX),
}).strict();

export type TemplateSubtask = z.infer<typeof templateSubtaskSchema>;
export type TemplateTask = z.infer<typeof templateTaskSchema>;
export type TemplateField = z.infer<typeof templateFieldSchema>;
export type TemplateAssignee = TemplateTask['assignee'];

const items = z.array(templateTaskSchema).min(1, 'Add at least one task').max(TEMPLATE_ITEMS_MAX, `A template holds ${TEMPLATE_ITEMS_MAX} tasks at most`);
const fields = z.array(templateFieldSchema).max(TEMPLATE_FIELDS_MAX, `A template has ${TEMPLATE_FIELDS_MAX} fill-in fields at most`);

/** What the template's content must also satisfy beyond its shape: fields, fill-ins and size. */
function contentIssues(value: { fields?: TemplateField[]; items?: TemplateTask[] }, ctx: z.RefinementCtx) {
  if (value.fields) {
    const seen = new Set<string>();
    value.fields.forEach((field, index) => {
      if (seen.has(field.key)) ctx.addIssue({ code: 'custom', path: ['fields', index, 'key'], message: `The field {${field.key}} is declared twice` });
      seen.add(field.key);
    });
  }
  if (value.items) {
    if (taskCount(value.items) > TEMPLATE_TASKS_MAX) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: `A template makes ${TEMPLATE_TASKS_MAX} tasks at most, subtasks included` });
    }
    if (value.fields) {
      const declared = new Set(value.fields.map((field) => field.key));
      const missing = [...usedPlaceholders(value.items)].filter((key) => !declared.has(key));
      if (missing.length) {
        ctx.addIssue({ code: 'custom', path: ['fields'], message: `Declare a fill-in field for ${missing.map((key) => `{${key}}`).join(', ')}` });
      }
    }
  }
}

export const createTaskTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(TEMPLATE_NAME_MAX, `A name is ${TEMPLATE_NAME_MAX} characters at most`),
  description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX).default(''),
  project_id: z.string().regex(UUID, 'project_id must be a uuid').nullable().default(null),
  fields: fields.default([]),
  items,
}).strict().superRefine(contentIssues);
export type CreateTaskTemplateInput = z.infer<typeof createTaskTemplateSchema>;

/** A change: send only what changes. fields and items are replaced whole (send both when the fill-ins change). */
export const updateTaskTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(TEMPLATE_NAME_MAX).optional(),
  description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX).optional(),
  project_id: z.string().regex(UUID, 'project_id must be a uuid').nullable().optional(),
  fields: fields.optional(),
  items: items.optional(),
}).strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change')
  .superRefine(contentIssues);
export type UpdateTaskTemplateInput = z.infer<typeof updateTaskTemplateSchema>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const runTaskTemplateSchema = z.object({
  /** Where the tasks go. Left out for a template locked to a project. */
  project_id: z.string().regex(UUID, 'project_id must be a uuid').optional(),
  /** Due dates count from here (default: today, in the runner's time zone). */
  start_date: date.optional(),
  /** A value for every fill-in field, by key. */
  values: z.record(z.string(), z.string().trim().max(TEMPLATE_VALUE_MAX, `A value is ${TEMPLATE_VALUE_MAX} characters at most`)).default({}),
}).strict();
export type RunTaskTemplateInput = z.infer<typeof runTaskTemplateSchema>;

// ── Views ─────────────────────────────────────────────────────────────────

/** A template as the library lists it: everything but its tasks. */
export interface TaskTemplateSummary {
  id: string;
  name: string;
  description: string;
  /** Locked to this project, or null for any project. */
  project_id: string | null;
  project_name: string | null;
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
  items: TemplateTask[];
  created_by_name: string | null;
}

/** A template as the library lists it, from the full view. */
export function templateSummary(view: TaskTemplateView): TaskTemplateSummary {
  return {
    id: view.id, name: view.name, description: view.description, project_id: view.project_id, project_name: view.project_name,
    fields: view.fields, item_count: view.item_count, task_count: view.task_count, version: view.version, run_count: view.run_count,
    last_run_at: view.last_run_at, created_by: view.created_by, created_at: view.created_at, updated_at: view.updated_at,
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
}

/** What a use answers: the run, the tasks it made (each subtask after its parent), and plain notes. */
export interface TaskTemplateRunResult<TTask = Record<string, unknown>> {
  run: TaskTemplateRunView;
  tasks: TTask[];
  /** Plain lines on anything left out ("Sam cannot open Acme, so ... is unassigned"). */
  notes: string[];
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
  const labels = new Map(current.map((field) => [field.key, field.label]));
  return [...usedPlaceholders(tasks)].map((key) => ({ key, label: labels.get(key) ?? labelForKey(key) }));
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

/** "Due on the start date", "Due 3 days after start": a relative due date in words. */
export function dueLabel(days: number | null): string {
  if (days === null) return 'No due date';
  if (days === 0) return 'Due on the start date';
  return `Due ${days} day${days === 1 ? '' : 's'} after start`;
}

/** The fields a use left empty. */
export function missingValues(fieldsDeclared: readonly TemplateField[], values: Readonly<Record<string, string>>): TemplateField[] {
  return fieldsDeclared.filter((field) => !(values[field.key] ?? '').trim());
}

/** One task a use will create. */
export interface PlannedTask {
  title: string;
  description: string;
  priority: TemplatePriority;
  tags: string[];
  /** The member to assign, or null. */
  assignee_id: string | null;
  due_date: string | null;
  subtasks: Omit<PlannedTask, 'subtasks'>[];
}

/**
 * What a use creates: fill-ins replaced, due dates counted from the start
 * date, "runner" resolved to whoever uses it. The server creates exactly
 * this; the screens show it before anyone clicks.
 */
export function planRun(
  tasks: readonly TemplateTask[],
  input: { startDate: string; values: Readonly<Record<string, string>>; runnerId: string | null },
): PlannedTask[] {
  const one = (task: TemplateSubtask): Omit<PlannedTask, 'subtasks'> => ({
    title: fillIn(task.title, input.values).trim(),
    description: fillIn(task.description ?? '', input.values),
    priority: task.priority ?? 'medium',
    tags: [...new Set(task.tags ?? [])],
    assignee_id: task.assignee === RUNNER ? input.runnerId : task.assignee ?? null,
    due_date: task.due_in_days === null || task.due_in_days === undefined ? null : addDays(input.startDate, task.due_in_days),
  });
  return tasks.map((task) => ({ ...one(task), subtasks: (task.subtasks ?? []).map(one) }));
}
