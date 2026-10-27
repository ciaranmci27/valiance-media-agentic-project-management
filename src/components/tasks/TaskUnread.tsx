'use client';

import { useCallback, useState } from 'react';
import { CirclePlus, History, Mail, MessageSquare, Paperclip, type LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import type { Task, TaskEventKind, TaskUpdate, TeamMember } from '@/lib/types';
import { topLevelTasks } from '@/lib/subtasks';

function timeAgo(dateStr: string): string {
  const diffMins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const hours = Math.floor(diffMins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Unread as a card shows it. A subtask has no card of its own on the board,
 * so a change to one marks its parent as updated: every count and filter
 * reads tasks through this, so a count never points at nothing.
 */
export function useCardUnread(): (task: Task) => 'new' | 'updated' | null {
  const { taskUnread, getSubtasks } = useApp();
  return (task) => taskUnread(task)
    ?? (!task.parent_task_id && getSubtasks(task.id).some((subtask) => !!taskUnread(subtask)) ? 'updated' : null);
}

/** A top-level task's subtasks that changed since the person looked. */
export function useUnreadSubtasks(): (task: Task) => Task[] {
  const { taskUnread, getSubtasks } = useApp();
  return (task) => (task.parent_task_id ? [] : getSubtasks(task.id).filter((subtask) => !!taskUnread(subtask)));
}

/** What the latest change did, after its maker's name. */
const DID: Record<TaskEventKind, string> = {
  comment: 'commented',
  email: 'linked an email',
  file: 'added a file',
  status: 'moved it',
  edit: 'edited it',
  subtask: 'updated subtasks',
  assignee: 'changed who is on it',
  review: 'reviewed it',
};

/**
 * "2 comments, 1 email and 3 changes since you looked. Latest: Ashley
 * commented 20m ago." Comments, emails and files are counted by name; the
 * rest are changes.
 */
export function describeTaskUpdate(update: TaskUpdate, team: TeamMember[]): string {
  const k = update.kinds;
  const changes = (k.edit ?? 0) + (k.status ?? 0) + (k.subtask ?? 0) + (k.assignee ?? 0) + (k.review ?? 0);
  const parts = [
    k.comment ? plural(k.comment, 'comment') : null,
    k.email ? plural(k.email, 'email') : null,
    k.file ? plural(k.file, 'file') : null,
    changes ? plural(changes, 'change') : null,
  ].filter((part): part is string => !!part);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  const who = updateAuthor(update, team);
  const since = update.seen_at ? ' since you looked' : '';
  return `${list}${since}. Latest: ${who} ${DID[update.last_kind]} ${timeAgo(update.last_at)}.`;
}

/** Who made the latest change, by name where known. */
function updateAuthor(update: TaskUpdate, team: TeamMember[]): string {
  return team.find((m) => m.id === update.last_member_id)?.name
    ?? (update.last_via === 'system' ? 'The app' : 'An API key');
}

const KIND_ICON: Record<TaskEventKind, LucideIcon> = {
  comment: MessageSquare,
  email: Mail,
  file: Paperclip,
  status: History,
  edit: History,
  subtask: History,
  assignee: History,
  review: History,
};

/**
 * The line on an unread card or row that says what happened, in words:
 * "New from Ashley", "Ashley commented 20m ago +2". The whole story is on
 * hover. Text, not a pill: the card's own wash is what makes it stand out.
 */
export function UnreadLabel({ task }: { task: Task }) {
  const { taskUnread, getTaskUpdate, team } = useApp();
  const { teamMemberId } = useAuth();
  const unreadSubtasks = useUnreadSubtasks();
  const state = taskUnread(task);
  if (!state) {
    // Only its subtasks changed: say so, and which.
    const changed = unreadSubtasks(task);
    if (changed.length === 0) return null;
    const latest = changed
      .map((subtask) => ({ subtask, update: getTaskUpdate(subtask.id) }))
      .sort((a, b) => (b.update?.last_at ?? '').localeCompare(a.update?.last_at ?? ''))[0];
    const who = latest.update ? updateAuthor(latest.update, team) : null;
    const text = `${who ? `${who} updated` : 'Updated'} ${changed.length === 1 ? 'a subtask' : plural(changed.length, 'subtask')}${latest.update ? ` ${timeAgo(latest.update.last_at)}` : ''}`;
    const detail = changed.map((subtask) => {
      const update = getTaskUpdate(subtask.id);
      return `"${subtask.title}": ${taskUnread(subtask) === 'new' ? 'new subtask.' : update ? describeTaskUpdate(update, team) : 'changed since you looked.'}`;
    }).join(' ');
    return (
      <Tooltip content={<span className="block max-w-64">{detail}</span>}>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-brand-300">
          <History size={13} className="flex-shrink-0" aria-hidden="true" />
          <span aria-hidden="true" className="truncate">{text}</span>
          <span className="sr-only">{`Subtasks updated: ${detail}`}</span>
        </span>
      </Tooltip>
    );
  }
  const update = getTaskUpdate(task.id);
  // New and made as me can only be one of my keys (the nightly recap).
  const creator = task.created_by === teamMemberId ? 'your API key' : team.find((m) => m.id === task.created_by)?.name;
  const detail = state === 'new'
    ? `New to you${creator ? `, from ${creator}` : ''}${task.created_note ? `: ${task.created_note}` : ''}.`
      + (update ? ` ${describeTaskUpdate(update, team)}` : '')
    : update ? describeTaskUpdate(update, team) : 'Changed since you looked.';
  const Icon = state === 'new' || !update ? CirclePlus : KIND_ICON[update.last_kind];
  const text = state === 'new' || !update
    ? `New${creator ? ` from ${creator}` : ''}`
    : `${updateAuthor(update, team)} ${DID[update.last_kind]} ${timeAgo(update.last_at)}`;
  const more = state === 'updated' && update && update.total > 1 ? update.total - 1 : 0;
  return (
    <Tooltip content={<span className="block max-w-64">{detail}</span>}>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-brand-300">
        <Icon size={13} className="flex-shrink-0" aria-hidden="true" />
        <span aria-hidden="true" className="truncate">{text}</span>
        {more > 0 && <span aria-hidden="true" className="flex-shrink-0 text-brand-300/80">+{more}</span>}
        <span className="sr-only">{state === 'new' ? detail : `Updated: ${detail}`}</span>
      </span>
    </Tooltip>
  );
}

/**
 * A quiet line above a project's tasks while any are unread: how many, show
 * only those, mark them all read. Gone when nothing is unread, so a calm
 * project keeps a calm toolbar.
 */
export function UnreadNotice({ tasks }: { tasks: Task[] }) {
  const { markTasksSeen, filters, setFilters } = useApp();
  const cardUnread = useCardUnread();
  const unreadSubtasks = useUnreadSubtasks();
  const states = tasks.map((task) => [task.id, cardUnread(task)] as const).filter(([, state]) => !!state);
  const unreadIds = states.map(([id]) => id);
  // Marking all read reads the subtasks behind them too.
  const toMark = [...unreadIds, ...tasks.flatMap((task) => unreadSubtasks(task).map((subtask) => subtask.id))];
  const on = !!filters.unread;
  if (unreadIds.length === 0 && !on) return null;

  const fresh = states.filter(([, state]) => state === 'new').length;
  const changed = states.length - fresh;
  const summary = unreadIds.length === 0
    ? 'Nothing unread'
    : on
      ? `Showing ${plural(unreadIds.length, 'unread task')}`
      : changed === 0
        ? `${plural(fresh, 'new task')} since you last looked`
        : fresh === 0
          ? `${plural(changed, 'task')} changed since you last looked`
          : `${plural(fresh, 'new task')} and ${changed} changed since you last looked`;
  const link = 'rounded font-medium text-brand-300 hover:text-brand-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-brand-500/[0.08] px-3 py-2 text-sm text-zinc-300">
      <History size={14} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
      <span>{summary}</span>
      <button type="button" onClick={() => setFilters({ ...filters, unread: !on })} className={link}>
        {on ? 'Show all' : 'Show only these'}
      </button>
      {unreadIds.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setFilters({ ...filters, unread: false });
            void markTasksSeen(toMark);
          }}
          className={link}
        >
          Mark all read
        </button>
      )}
    </div>
  );
}

/** How many unread tasks each project has, for the projects list and the sidebar. */
export function useUnreadByProject(): Map<string, number> {
  const { tasks } = useApp();
  const cardUnread = useCardUnread();
  const counts = new Map<string, number>();
  // Counted as the board shows them: a subtask's change counts once, on its parent.
  for (const task of topLevelTasks(tasks)) {
    if (cardUnread(task)) counts.set(task.project_id, (counts.get(task.project_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * When the person last looked at a task, fixed when it opens (before opening
 * marks it read): what arrived after that, from someone else, is new to
 * them. Null when nothing changed since their last look, or they never
 * opened it (the whole task is new then, so nothing is singled out).
 */
export function useLookedSince(taskId: string | undefined): (at: string, by: string | null) => boolean {
  const { getTaskUpdate } = useApp();
  const { teamMemberId } = useAuth();
  const [looked, setLooked] = useState<{ taskId: string; at: number | null } | null>(null);
  if (taskId && looked?.taskId !== taskId) {
    const seen = getTaskUpdate(taskId)?.seen_at;
    setLooked({ taskId, at: seen ? Date.parse(seen) : null });
  }
  const since = looked && looked.taskId === taskId ? looked.at : null;
  return useCallback(
    (at: string, by: string | null) => since !== null && Date.parse(at) > since && by !== teamMemberId,
    [since, teamMemberId],
  );
}

/** The line above the first item that arrived since the person last looked. */
export function NewSinceDivider() {
  return (
    <li className="flex items-center gap-2 py-1 text-xs font-medium text-brand-300">
      <span className="h-px flex-1 bg-brand-500/40" aria-hidden="true" />
      New since you looked
      <span className="h-px flex-1 bg-brand-500/40" aria-hidden="true" />
    </li>
  );
}
