import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assignTemplateKeys, isCalendarDate, keyDatesOf, mainKeyDate, planRun, templateIssue,
  type ReflowTemplateRunInput, type TemplateIssue, type TemplateKeyDate, type TemplateTask,
} from '@/lib/task-templates';
import { accessAllowsProject } from './access';
import { callerChannel, callerHolds, type AgentCaller } from './agent-owners';
import { assertProjectWritable } from './request-gate';
import { ApiError, forbidden, notFound } from './errors';
import { canRunTemplates, missingTemplatesSchema, runnerToday, templateErrors } from './task-templates';

/**
 * Changing a live run's key dates (reflow), for the API (v1, MCP) and the
 * session routes. One function; dry_run answers what it would do, writing
 * nothing. The rules:
 * - Only a live run moves: one that made an initiative (the initiative page
 *   is the run page). Another is 409 run_not_live.
 * - Due dates recompute from key date plus offset only, from the run's own
 *   snapshot of the template; dependencies never drive dates.
 * - A task moves only while it is not done, not in Trash, and still due on
 *   the date the run planned (planned_due_date). A task someone changed by
 *   hand comes back as kept (reason hand_changed), and moves only when its id
 *   is in include_task_ids. Done and trashed tasks come back as ignored.
 * - Only tasks the caller may edit move (tasks.manage_all, or
 *   tasks.manage_assigned on their own tasks and the subtasks of those);
 *   others come back as kept (reason cannot_edit). Using it needs
 *   tasks.create on the run's project.
 * - The initiative's dates follow under the same rule: its target the main
 *   key date, its start the earliest key date, each only while it still is
 *   the old date. While the initiative is in Trash nothing moves (409
 *   initiative_in_trash, a dry run too): restore it first.
 * - A warning names every new date (a key date or a task's due date) that
 *   lands before today in the caller's time zone.
 * - Writing (pm.reflow_task_template_run) is one transaction: the moved tasks
 *   and their planned dates, the run's key dates, the initiative's target,
 *   and one team activity entry as the caller. A run whose key dates changed
 *   since they were read is 409 run_changed: read it again.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids per .in() read, so the URL stays short. */
const CHUNK = 100;

/** A date (YYYY-MM-DD) from a date column or a task's due_date text, or null. */
const dayOf = (value: unknown): string | null => (typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : value instanceof Date ? value.toISOString().slice(0, 10) : null);

const objectOf = (value: unknown): Record<string, string> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {});

export const reflowMigrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Changing a run\'s key dates works once the database update 20261126000300_template_reflow_drafts.sql is applied', { reason: 'migration_pending' });

/** A task the reflow moves (or would move). */
export interface ReflowTask {
  task_id: string;
  item_key: string;
  title: string;
  parent_task_id: string | null;
  /** Its due date now. */
  from: string | null;
  /** The due date the new key dates plan. */
  to: string | null;
}

/** A task the reflow leaves where it is. */
export interface ReflowKept extends ReflowTask {
  /** hand_changed: someone changed its due date (include its id to move it anyway); cannot_edit: the caller may not edit it. */
  reason: 'hand_changed' | 'cannot_edit';
  /** The date the run planned for it. */
  planned: string | null;
  can_include: boolean;
}

export interface ReflowWarning {
  code: 'date_in_past';
  message: string;
  /** The key date or the task it is about. */
  key_date?: string;
  task_id?: string;
  date: string;
}

export interface ReflowResult {
  dry_run: boolean;
  run_id: string;
  template_id: string;
  project_id: string;
  initiative_id: string;
  key_dates: { from: Record<string, string>; to: Record<string, string> };
  main_key_date: string;
  moved: ReflowTask[];
  kept: ReflowKept[];
  ignored: { task_id: string; item_key: string; title: string; reason: 'done' | 'trashed' }[];
  /** Tasks whose planned date does not change. */
  unchanged: number;
  initiative: ReflowInitiative | null;
  warnings: ReflowWarning[];
}

/**
 * The run's initiative and its dates: the target follows the main key date
 * (from, to, follows), the start the earliest key date (start_from,
 * start_to, start_follows), each only while it still is the old date.
 */
export interface ReflowInitiative {
  id: string;
  name: string;
  target_date: string | null;
  from: string | null;
  to: string | null;
  follows: boolean;
  start_date: string | null;
  start_from: string | null;
  start_to: string | null;
  start_follows: boolean;
}

async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < ids.length; start += CHUNK) {
    const { data, error } = await read(ids.slice(start, start + CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/**
 * Moves a live run to new key dates (or, with dry_run, answers what that
 * would do). key_dates holds only the key dates that change.
 */
export async function reflowTemplateRun(service: SupabaseClient, caller: AgentCaller, runId: string, input: ReflowTemplateRunInput): Promise<ReflowResult> {
  if (!UUID.test(runId)) throw notFound('Run');
  if (!canRunTemplates(caller)) {
    throw forbidden('Changing a run\'s dates needs tasks.create on its project', {
      reason: 'missing_permission', needs: 'tasks.create', hint: 'Ask an Owner to grant you Create tasks.',
    });
  }
  const { data: runRow, error: runError } = await service.from('task_template_runs')
    .select('id, template_id, snapshot, project_id, start_date, key_dates, initiative_id').eq('id', runId).maybeSingle();
  if (runError) {
    if (missingTemplatesSchema(runError)) throw reflowMigrationPending();
    throw runError;
  }
  const run = runRow as Row | null;
  // Out of reach and missing read the same.
  if (!run || !accessAllowsProject(caller.access, run.project_id, callerChannel(caller))) throw notFound('Run');
  if (!run.initiative_id) {
    throw new ApiError(409, 'CONFLICT', 'Only a run that made an initiative stays live: this one made none, so its key dates cannot change', {
      reason: 'run_not_live', hint: 'Change its tasks\' due dates one by one, or run the template again with create_initiative true.',
    });
  }

  // The run's own template, as it was when it ran.
  const keyDateList: TemplateKeyDate[] = keyDatesOf(Array.isArray(run.snapshot?.key_dates) ? run.snapshot.key_dates as TemplateKeyDate[] : null);
  const items = assignTemplateKeys(Array.isArray(run.snapshot?.items) ? run.snapshot.items as TemplateTask[] : []);
  const stored = objectOf(run.key_dates);
  const startDate = dayOf(run.start_date);
  const from: Record<string, string> = Object.keys(stored).length ? { ...stored } : (startDate ? { start: startDate } : {});

  const errors: TemplateIssue[] = [];
  const known = new Set(keyDateList.map((keyDate) => keyDate.key));
  for (const [key, value] of Object.entries(input.key_dates)) {
    if (!known.has(key)) {
      errors.push(templateIssue(['key_dates', key], 'unknown_key_date', `"${key}" is not one of this run's key dates`, `Use: ${[...known].join(', ')}.`));
    } else if (!isCalendarDate(value)) {
      errors.push(templateIssue(['key_dates', key], 'invalid_date', `${value} is not a real date`, 'Use a real calendar date, YYYY-MM-DD.'));
    }
  }
  const to: Record<string, string> = { ...from, ...input.key_dates };
  const mainKey = mainKeyDate(keyDateList).key;

  // Due dates from key date plus offset, nothing else.
  const plan = planRun(items, { keyDates: to, defaultAnchor: keyDateList[0].key, values: {}, runnerId: null, roleMembers: {} });
  const plannedByKey = new Map<string, string | null>();
  for (const task of plan) {
    plannedByKey.set(task.key as string, task.due_date);
    for (const subtask of task.subtasks) plannedByKey.set(subtask.key as string, subtask.due_date);
  }

  const { data: linkRows, error: linkError } = await service.from('task_template_run_tasks')
    .select('task_id, item_key, planned_due_date').eq('run_id', runId);
  if (linkError) {
    if (missingTemplatesSchema(linkError)) throw reflowMigrationPending();
    throw linkError;
  }
  const links = (linkRows ?? []) as { task_id: string; item_key: string; planned_due_date: unknown }[];
  const ids = links.map((link) => link.task_id);
  const include = new Set(input.include_task_ids ?? []);
  const linked = new Set(ids);
  (input.include_task_ids ?? []).forEach((taskId, i) => {
    if (!linked.has(taskId)) {
      errors.push(templateIssue(['include_task_ids', i], 'unknown_step', 'That task is not one this run made', 'Send ids from kept in a dry run.'));
    }
  });
  if (errors.length) throw templateErrors(errors);

  const manageAll = callerHolds(caller, 'tasks.manage_all');
  const manageAssigned = callerHolds(caller, 'tasks.manage_assigned');
  const [tasks, mine, initiativeRow, today] = await Promise.all([
    inChunks<Row>(ids, (chunk) => service.from('tasks').select('id, title, status, due_date, deleted_at, parent_task_id').in('id', chunk)),
    manageAll || !manageAssigned ? Promise.resolve([] as Row[])
      : inChunks<Row>(ids, (chunk) => service.from('task_assignees').select('task_id').eq('member_id', caller.memberId).in('task_id', chunk)),
    service.from('initiatives').select('id, name, start_date, target_date, deleted_at').eq('id', run.initiative_id).maybeSingle(),
    runnerToday(service, caller.memberId),
  ]);
  if (initiativeRow.error) throw initiativeRow.error;
  // The run lives on its initiative: while that is in Trash, its dates stay
  // as they are (a dry run says so too), so the two never drift apart.
  if ((initiativeRow.data as Row | null)?.deleted_at) throw initiativeInTrash();
  const byId = new Map(tasks.map((task) => [task.id as string, task]));
  const assignedToMe = new Set(mine.map((row) => row.task_id as string));
  const mayEdit = (task: Row) => manageAll || (manageAssigned
    && (assignedToMe.has(task.id) || (!!task.parent_task_id && assignedToMe.has(task.parent_task_id))));

  const moved: ReflowTask[] = [];
  const kept: ReflowKept[] = [];
  const ignored: ReflowResult['ignored'] = [];
  const moves: { task_id: string; due_date: string | null; force: boolean }[] = [];
  const warnings: ReflowWarning[] = [];
  let unchanged = 0;
  for (const link of links) {
    if (!plannedByKey.has(link.item_key)) continue;
    const task = byId.get(link.task_id);
    const title = (task?.title as string | undefined) ?? '';
    if (!task || task.deleted_at) {
      ignored.push({ task_id: link.task_id, item_key: link.item_key, title, reason: 'trashed' });
      continue;
    }
    if (task.status === 'done') {
      ignored.push({ task_id: link.task_id, item_key: link.item_key, title, reason: 'done' });
      continue;
    }
    const planned = dayOf(link.planned_due_date);
    const current = dayOf(task.due_date);
    const next = plannedByKey.get(link.item_key) ?? null;
    const untouched = current === planned;
    const opted = include.has(link.task_id);
    if (next === planned && (untouched || !opted)) {
      unchanged++;
      continue;
    }
    const entry: ReflowTask = { task_id: link.task_id, item_key: link.item_key, title, parent_task_id: (task.parent_task_id as string | null) ?? null, from: current, to: next };
    if (!mayEdit(task)) {
      kept.push({ ...entry, reason: 'cannot_edit', planned, can_include: false });
    } else if (untouched || opted) {
      moves.push({ task_id: link.task_id, due_date: next, force: !untouched });
      moved.push(entry);
      if (next && next < today) {
        warnings.push({ code: 'date_in_past', task_id: link.task_id, date: next, message: `"${title}" would be due ${next}, before today.` });
      }
    } else {
      kept.push({ ...entry, reason: 'hand_changed', planned, can_include: true });
    }
  }
  for (const [key, value] of Object.entries(input.key_dates)) {
    if (value !== from[key] && value < today) {
      const label = keyDateList.find((keyDate) => keyDate.key === key)?.label ?? key;
      warnings.unshift({ code: 'date_in_past', key_date: key, date: value, message: `${label} is ${value}, before today.` });
    }
  }

  const ini = initiativeRow.data as Row | null;
  const oldMain = from[mainKey] ?? null;
  const newMain = to[mainKey] ?? null;
  const target = ini ? dayOf(ini.target_date) : null;
  // Its start follows the earliest key date (what the run set it to), under the same rule.
  const earliest = (dates: Record<string, string>) => Object.values(dates).filter(Boolean).sort()[0] ?? null;
  const oldStart = earliest(from);
  const newStart = earliest(to);
  const start = ini ? dayOf(ini.start_date) : null;
  const initiative: ReflowInitiative | null = ini && !ini.deleted_at ? {
    id: ini.id as string, name: ini.name as string, target_date: target, from: oldMain, to: newMain,
    follows: oldMain !== newMain && target === oldMain,
    start_date: start, start_from: oldStart, start_to: newStart,
    start_follows: oldStart !== newStart && start === oldStart,
  } : null;

  const result: ReflowResult = {
    dry_run: input.dry_run === true,
    run_id: run.id,
    template_id: run.template_id,
    project_id: run.project_id,
    initiative_id: run.initiative_id,
    key_dates: { from, to },
    main_key_date: mainKey,
    moved,
    kept,
    ignored,
    unchanged,
    initiative,
    warnings,
  };
  if (input.dry_run) return result;

  assertProjectWritable(run.project_id);
  const datesChange = Object.keys(input.key_dates).some((key) => input.key_dates[key] !== from[key]);
  if (!datesChange && moves.length === 0) return result;
  const { data, error } = await service.rpc('reflow_task_template_run', {
    p_run_id: run.id,
    p_expected: run.key_dates ?? {},
    p_key_dates: to,
    p_start_date: to.start ?? to[keyDateList[0].key] ?? null,
    p_moves: moves,
    p_initiative: initiative && (initiative.follows || initiative.start_follows) ? {
      id: initiative.id,
      ...(initiative.follows ? { from: oldMain, to: newMain } : {}),
      ...(initiative.start_follows ? { start_from: oldStart, start_to: newStart } : {}),
    } : null,
  });
  if (error) {
    if (/initiative_in_trash/.test(error.message ?? '')) throw initiativeInTrash();
    if (/run_changed/.test(error.message ?? '')) {
      throw new ApiError(409, 'CONFLICT', 'This run\'s key dates changed a moment ago. Read it again.', {
        reason: 'run_changed', hint: 'Run the reflow again with dry_run true to see the new plan.',
      });
    }
    if (/run_not_found/.test(error.message ?? '')) throw notFound('Run');
    if (missingTemplatesSchema(error)) throw reflowMigrationPending();
    throw error;
  }
  const answer = (data ?? {}) as { moved?: string[]; initiative_moved?: boolean; initiative_start_moved?: boolean };
  const done = new Set(answer.moved ?? []);
  // A task changed by hand between the read and the write stays where it is.
  for (const entry of moved.filter((task) => !done.has(task.task_id))) {
    kept.push({ ...entry, reason: 'hand_changed', planned: null, can_include: true });
  }
  return {
    ...result,
    moved: moved.filter((task) => done.has(task.task_id)),
    kept,
    initiative: initiative ? {
      ...initiative,
      follows: answer.initiative_moved === true, target_date: answer.initiative_moved ? newMain : target,
      start_follows: answer.initiative_start_moved === true, start_date: answer.initiative_start_moved ? newStart : start,
    } : null,
  };
}

const initiativeInTrash = () => new ApiError(409, 'CONFLICT', 'This run\'s initiative is in Trash, so its dates cannot change. Restore the initiative first.', {
  reason: 'initiative_in_trash', hint: 'Restore the initiative from Trash, then change the dates.',
});
