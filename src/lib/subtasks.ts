import type { Task } from '@/lib/types';

/**
 * Subtasks are tasks with parent_task_id set, one level deep. Every screen
 * that lists tasks decides here which ones it shows, so they cannot drift:
 * project lists, the board, the calendar and progress show top-level tasks;
 * My Tasks, needs-you and workload counts include subtasks (they are
 * someone's work) and name the parent beside them.
 */

export function isSubtask(task: Pick<Task, 'parent_task_id'>): boolean {
  return !!task.parent_task_id;
}

export function topLevelTasks<T extends Pick<Task, 'parent_task_id'>>(tasks: T[]): T[] {
  return tasks.filter((task) => !task.parent_task_id);
}

/** Siblings in their order: sort_order, then the oldest first. */
export function bySubtaskOrder(a: Pick<Task, 'sort_order' | 'created_at'>, b: Pick<Task, 'sort_order' | 'created_at'>): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.created_at.localeCompare(b.created_at);
}

/** Each parent's subtasks, in order. */
export function subtasksByParent(tasks: Task[]): Map<string, Task[]> {
  const byParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const list = byParent.get(task.parent_task_id) ?? [];
    list.push(task);
    byParent.set(task.parent_task_id, list);
  }
  for (const list of byParent.values()) list.sort(bySubtaskOrder);
  return byParent;
}

export interface SubtaskProgress {
  done: number;
  total: number;
}

export function subtaskProgress(subtasks: Task[]): SubtaskProgress {
  return { done: subtasks.filter((task) => task.status === 'done').length, total: subtasks.length };
}
