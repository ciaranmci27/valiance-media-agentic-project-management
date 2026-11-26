import type { Task, TaskUpdate } from '@/lib/types';
import { appLocale } from '@/lib/region';
import { formatAgo } from '@/lib/time-format';

/**
 * When anything last happened on a task. A task's own updated_at moves only
 * when its fields change, so a new comment, a subtask finished or a file
 * someone else added would otherwise leave "updated" looking stale. The
 * unread event (another person's newest change) covers files and emails.
 */
export function lastActivityAt(
  task: Pick<Task, 'updated_at' | 'comments'>,
  subtasks: Pick<Task, 'updated_at'>[] = [],
  update?: Pick<TaskUpdate, 'last_at'>,
): string {
  let latest = task.updated_at;
  const consider = (at: string | null | undefined) => {
    if (at && new Date(at).getTime() > new Date(latest).getTime()) latest = at;
  };
  for (const comment of task.comments ?? []) consider(comment.created_at);
  for (const subtask of subtasks) consider(subtask.updated_at);
  consider(update?.last_at);
  return latest;
}

/**
 * The way Messages does it: "Just now", "5 min ago", "2 h ago" while it is
 * still today, "Yesterday", then the date ("Oct 24", with the year when it is
 * not this year). A wrapper over the one time format family (lib/time-format).
 */
export function timeAgo(dateStr: string, now: Date = new Date()): string {
  return formatAgo(dateStr, { now });
}

/** "Created Oct 12, 2026". */
export function createdLabel(createdAt: string): string {
  return `Created ${new Date(createdAt).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** Both times, for a tooltip: "Created Oct 12, 2026 · Updated 30 min ago". */
export function taskTimesTooltip(createdAt: string, lastAt: string): string {
  // Mid-sentence: "Updated just now", "Updated yesterday".
  return `${createdLabel(createdAt)} · Updated ${formatAgo(lastAt, { midSentence: true })}`;
}
