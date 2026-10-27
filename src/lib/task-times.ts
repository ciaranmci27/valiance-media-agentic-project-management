import type { Task, TaskUpdate } from '@/lib/types';

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
 * The way Messages does it: "Just now", "5 min ago", "3 hours ago" while it is
 * still today, "Yesterday", then the date ("Oct 24", with the year when it is
 * not this year).
 */
export function timeAgo(dateStr: string, now: Date = new Date()): string {
  const then = new Date(dateStr);
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (then.getTime() >= startOfToday) {
    const hours = Math.floor(mins / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  if (then.getTime() >= startOfToday - 86_400_000) return 'Yesterday';
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "Created Oct 12, 2026". */
export function createdLabel(createdAt: string): string {
  return `Created ${new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** Both times, for a tooltip: "Created Oct 12, 2026 · Updated 30 min ago". */
export function taskTimesTooltip(createdAt: string, lastAt: string): string {
  const updated = timeAgo(lastAt);
  // Mid-sentence: "Updated just now", "Updated yesterday".
  const phrase = updated === 'Just now' || updated === 'Yesterday' ? updated.toLowerCase() : updated;
  return `${createdLabel(createdAt)} · Updated ${phrase}`;
}
