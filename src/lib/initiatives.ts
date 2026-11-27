import { z } from 'zod';
import { calendarDate } from '@/lib/schemas/shared';
import {
  INITIATIVE_ENTRY_KINDS, INITIATIVE_ENTRY_STATUSES, INITIATIVE_HEALTHS, INITIATIVE_STATUSES,
  type Initiative, type InitiativeEntry, type InitiativeEntryKind, type InitiativeHealth, type InitiativeStatus, type Task,
} from '@/lib/types';

/**
 * Initiatives: a named body of work inside a project, with a description,
 * an owner, a status, its own board (the project's tasks tagged with it) and
 * its log. A project goal (project_goals) is an outcome to reach; an
 * initiative is the work toward something, with a board. The log is the
 * dated record (updates, decisions, issues, notes); the brief is standing
 * knowledge (context scope 'initiative'); a proposed task is a task
 * suggestion, never a log entry.
 *
 * Rules (the database enforces them; see 20261126000100_initiatives.sql):
 * - A task belongs to at most one initiative, in its own project. A subtask
 *   always has its parent's. Moving a task to another project clears it.
 * - An initiative in Trash reads as missing; its tasks keep the link and
 *   read as having none until it is restored.
 * - Progress is top-level tasks done of top-level tasks (subtasks left out),
 *   counting only the tasks the reader can see.
 *
 * `initiative` is the permanent technical name (tables, API, MCP, webhooks).
 * What people read is INITIATIVE_LABEL, so the word on screen changes here
 * alone.
 */

export const INITIATIVE_LABEL = {
  singular: 'Initiative',
  plural: 'Initiatives',
  /** Mid-sentence: "Add to an initiative". */
  lower: 'initiative',
  lowerPlural: 'initiatives',
} as const;

export const INITIATIVE_NAME_MAX = 120;
export const INITIATIVE_DESCRIPTION_MAX = 5000;
export const INITIATIVE_ENTRY_TITLE_MAX = 200;
export const INITIATIVE_ENTRY_BODY_MAX = 20_000;

/** Bounds of an initiative's starting read (get_initiative, the page header). */
export const INITIATIVE_READ_LIMITS = {
  openIssues: 20,
  recentEntries: 10,
  /** A page of the log. */
  entriesPage: 50,
} as const;

export const INITIATIVE_STATUS_LABELS: Record<InitiativeStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
};

export const INITIATIVE_HEALTH_LABELS: Record<InitiativeHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  blocked: 'Blocked',
};

export const INITIATIVE_ENTRY_KIND_LABELS: Record<InitiativeEntryKind, string> = {
  update: 'Update',
  decision: 'Decision',
  issue: 'Issue',
  note: 'Note',
};

export function initiativeStatusLabel(status: InitiativeStatus): string {
  return INITIATIVE_STATUS_LABELS[status] ?? status;
}

/** The health label, or null when it has none (it is not active, or nobody set it). */
export function initiativeHealthLabel(initiative: Pick<Initiative, 'status' | 'health'>): string | null {
  return initiative.status === 'active' && initiative.health ? INITIATIVE_HEALTH_LABELS[initiative.health] : null;
}

/** One line for a card: "Active, at risk", "Planned", "Done". */
export function initiativeStateLabel(initiative: Pick<Initiative, 'status' | 'health'>): string {
  const health = initiativeHealthLabel(initiative);
  return health ? `${initiativeStatusLabel(initiative.status)}, ${health.toLowerCase()}` : initiativeStatusLabel(initiative.status);
}

/** Done ones sit behind "Show done". */
export const isOpenInitiative = (initiative: Pick<Initiative, 'status'>) => initiative.status !== 'done';

/** A project's initiatives in their order: sort_order, then oldest first. */
export function sortInitiatives<T extends Pick<Initiative, 'sort_order' | 'created_at' | 'id'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

// ── Progress from the store ─────────────────────────────────────────────

export interface InitiativeProgress {
  done: number;
  total: number;
}

type ProgressTask = Pick<Task, 'initiative_id' | 'parent_task_id' | 'status'>;

/**
 * Done and total top-level tasks per initiative, from the tasks the screen
 * holds (the store holds only what the person can see, so it counts only
 * those). Subtasks are left out. One pass over the list.
 */
export function progressByInitiative(tasks: readonly ProgressTask[]): Map<string, InitiativeProgress> {
  const out = new Map<string, InitiativeProgress>();
  for (const task of tasks) {
    if (!task.initiative_id || task.parent_task_id) continue;
    const row = out.get(task.initiative_id) ?? { done: 0, total: 0 };
    row.total += 1;
    if (task.status === 'done') row.done += 1;
    out.set(task.initiative_id, row);
  }
  return out;
}

export function initiativeProgress(tasks: readonly ProgressTask[], initiativeId: string): InitiativeProgress {
  return progressByInitiative(tasks.filter((task) => task.initiative_id === initiativeId)).get(initiativeId) ?? { done: 0, total: 0 };
}

/** 0 to 100, rounded down; 0 for an initiative with no tasks. */
export function progressPercent(progress: InitiativeProgress | null | undefined): number {
  if (!progress || progress.total <= 0) return 0;
  return Math.floor((progress.done / progress.total) * 100);
}

/** "3 of 8 tasks done", "No tasks yet". */
export function progressLabel(progress: InitiativeProgress | null | undefined): string {
  if (!progress || progress.total === 0) return 'No tasks yet';
  return `${progress.done} of ${progress.total} ${progress.total === 1 ? 'task' : 'tasks'} done`;
}

/**
 * The initiative a task reads as being in: its id when that initiative is
 * live (in `live`), else null (none, or one in Trash).
 */
export function taskInitiativeId(task: Pick<Task, 'initiative_id'>, live: ReadonlySet<string>): string | null {
  return task.initiative_id && live.has(task.initiative_id) ? task.initiative_id : null;
}

/** A task predicate for an initiative's board: its tasks, subtasks included. */
export const inInitiative = (initiativeId: string) => (task: Pick<Task, 'initiative_id'>) => task.initiative_id === initiativeId;

// ── What the server answers ─────────────────────────────────────────────

/** Who owns it, named: a member or a group. null when it has no owner (or the owner left). */
export interface InitiativeOwner {
  kind: 'member' | 'group';
  id: string;
  name: string;
}

/** An initiative as lists and the page header read it. */
export interface InitiativeView extends Initiative {
  owner: InitiativeOwner | null;
  /** Top-level tasks done and in all, of the tasks the reader can see; null when they cannot read tasks. */
  progress: InitiativeProgress | null;
  /** Open issues in its log; null when the reader cannot read the log. */
  open_issue_count: number | null;
  /** When its log last gained an entry; null with none, or when the reader cannot read the log. */
  last_entry_at: string | null;
}

/** A log entry with its people named. */
export interface InitiativeEntryView extends InitiativeEntry {
  created_by_name: string | null;
  resolved_by_name: string | null;
}

/** A bounded list: the rows shown and how many more there are. */
export interface Bounded<T> {
  rows: T[];
  more: number;
}

/** A pinned brief entry, cut to fit. */
export interface InitiativeBriefEntry {
  id: string;
  section: string;
  content: string;
  content_truncated?: boolean;
}

/**
 * An initiative's starting read (GET .../initiatives/:id, get_initiative):
 * the header with progress, open issues (newest 20), the last 10 entries and
 * the pinned brief entries. null parts are ones the reader may not see.
 */
/**
 * The template run that made an initiative (task_template_runs.initiative_id):
 * the template's name and the run's key dates in the template's order. The
 * initiative page shows it as one strip under the header.
 */
export interface InitiativeTemplateRun {
  run_id: string;
  template_id: string;
  template_name: string;
  key_dates: { key: string; label: string; date: string; main: boolean }[];
  run_by_name: string | null;
  created_at: string;
}

export interface InitiativeDetail {
  initiative: InitiativeView;
  /** The template run that made it, or null (no run made it). The strip shows only when it is there. */
  template_run?: InitiativeTemplateRun | null;
  open_issues: Bounded<InitiativeEntryView> | null;
  recent_entries: Bounded<InitiativeEntryView> | null;
  brief: Bounded<InitiativeBriefEntry> | null;
  /** What the reader may do here. */
  can: { edit: boolean; trash: boolean; log: boolean; read_brief: boolean; edit_brief: boolean };
}

// ── Requests ────────────────────────────────────────────────────────────

const day = calendarDate;
const uuid = (what: string) => z.uuid(`${what} must be a uuid`);

const ownerFields = {
  owner_member_id: uuid('owner_member_id').nullable().optional(),
  owner_group_id: uuid('owner_group_id').nullable().optional(),
};
const oneOwner = (value: { owner_member_id?: string | null; owner_group_id?: string | null }) =>
  !(value.owner_member_id && value.owner_group_id);
const ONE_OWNER = { message: 'An initiative has one owner: a member or a group, not both', path: ['owner_group_id'] };
const datesInOrder = (value: { start_date?: string | null; target_date?: string | null }) =>
  !value.start_date || !value.target_date || value.target_date >= value.start_date;
const DATES_IN_ORDER = { message: 'The target date cannot be before the start date', path: ['target_date'] };

export const createInitiativeSchema = z.object({
  name: z.string().trim().min(1, 'Name it').max(INITIATIVE_NAME_MAX),
  description: z.string().max(INITIATIVE_DESCRIPTION_MAX).optional(),
  ...ownerFields,
  status: z.enum(INITIATIVE_STATUSES).optional(),
  health: z.enum(INITIATIVE_HEALTHS).nullable().optional(),
  start_date: day.nullable().optional(),
  target_date: day.nullable().optional(),
  sort_order: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine(oneOwner, ONE_OWNER).refine(datesInOrder, DATES_IN_ORDER);
export type CreateInitiativeInput = z.infer<typeof createInitiativeSchema>;

export const updateInitiativeSchema = z.object({
  name: z.string().trim().min(1, 'Name it').max(INITIATIVE_NAME_MAX).optional(),
  description: z.string().max(INITIATIVE_DESCRIPTION_MAX).optional(),
  ...ownerFields,
  status: z.enum(INITIATIVE_STATUSES).optional(),
  health: z.enum(INITIATIVE_HEALTHS).nullable().optional(),
  start_date: day.nullable().optional(),
  target_date: day.nullable().optional(),
  sort_order: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine(oneOwner, ONE_OWNER).refine(datesInOrder, DATES_IN_ORDER);
export type UpdateInitiativeInput = z.infer<typeof updateInitiativeSchema>;

export const createInitiativeEntrySchema = z.object({
  kind: z.enum(INITIATIVE_ENTRY_KINDS),
  title: z.string().trim().min(1, 'Give it a title').max(INITIATIVE_ENTRY_TITLE_MAX),
  body: z.string().max(INITIATIVE_ENTRY_BODY_MAX).optional(),
  task_id: uuid('task_id').nullable().optional(),
}).strict();
export type CreateInitiativeEntryInput = z.infer<typeof createInitiativeEntrySchema>;

/** Its author changes title, body and task; anyone who may log resolves or reopens an issue (status). */
export const updateInitiativeEntrySchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(INITIATIVE_ENTRY_TITLE_MAX).optional(),
  body: z.string().max(INITIATIVE_ENTRY_BODY_MAX).optional(),
  task_id: uuid('task_id').nullable().optional(),
  status: z.enum(INITIATIVE_ENTRY_STATUSES).optional(),
}).strict().refine((value) => Object.values(value).some((field) => field !== undefined), 'Send at least one field to change');
export type UpdateInitiativeEntryInput = z.infer<typeof updateInitiativeEntrySchema>;
