'use client';

import { useId } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useTaskWarmer } from '@/lib/reads';
import { Avatar } from '@/components/ui/Avatar';
import { subtaskProgress } from '@/lib/subtasks';
import { TASK_STATUS_LABELS } from '@/lib/task-copy';
import { isDateOverdue } from '@/lib/date-utils';
import { formatCalendarDay } from '@/lib/time-format';
import { SubtaskRing, SUBTASK_STATUS_RING } from './SubtaskRing';

/** Why a subtask is on My Tasks: what it says, and what opening it does. */
export interface SubtaskFlag {
  context: string;
  /** Opens the briefing (merge, review) instead of the task panel. */
  onOpen?: () => void;
  /** One action for you: said in amber, like the band it sits in. */
  action?: boolean;
}

const shortDate = (date: string) => formatCalendarDay(date);

/**
 * A parent's subtasks on My Tasks, under the parent's row: one line with the
 * progress ring and "2 of 3 subtasks done" that opens a tray of them, the
 * open ones first. The ones that put the parent on the page say why; the
 * rest show their status. Rows line up with the parent's title.
 */
export function MyTaskSubtasks({
  parent,
  flags,
  open,
  onToggle,
  onOpenTask,
}: {
  parent: Task;
  flags: Map<string, SubtaskFlag>;
  open: boolean;
  onToggle: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { getSubtasks, taskUnread, team } = useApp();
  const { teamMemberId } = useAuth();
  const warmTask = useTaskWarmer();
  const trayId = useId();
  const subtasks = getSubtasks(parent.id);
  if (subtasks.length === 0) return null;
  const progress = subtaskProgress(subtasks);
  const ordered = [...subtasks.filter(s => s.status !== 'done'), ...subtasks.filter(s => s.status === 'done')];

  const subtaskRow = (subtask: Task) => {
    const flag = flags.get(subtask.id);
    const done = subtask.status === 'done';
    const late = !!subtask.due_date && !done && isDateOverdue(subtask.due_date);
    const mine = !!teamMemberId && subtask.assignee_ids.includes(teamMemberId);
    // Someone else's piece shows whose it is; yours needs no face.
    const owner = mine ? undefined : team.find(m => m.id === subtask.assignee_ids[0]);
    const unread = !!taskUnread(subtask);
    const status = TASK_STATUS_LABELS[subtask.status];
    return (
      <li key={subtask.id}>
        <button
          type="button"
          onClick={() => (flag?.onOpen ? flag.onOpen() : onOpenTask(subtask.id))}
          className="w-full grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-left rounded-[10px] hover:bg-white/[0.04] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
          {...warmTask(subtask.id)}
        >
          <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full ${done ? 'bg-emerald-500' : SUBTASK_STATUS_RING[subtask.status]}`} aria-hidden="true">
            {done && <Check size={10} strokeWidth={3} className="text-white" />}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className={`truncate text-sm ${done ? 'text-zinc-500 line-through' : flag ? 'text-white font-medium' : 'text-zinc-200'}`}>
                {subtask.title}
              </span>
              {unread && (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400 flex-shrink-0" aria-hidden="true" />
                  <span className="sr-only">, changed since you looked</span>
                </>
              )}
            </span>
            <span className={`block truncate text-xs ${flag?.action ? 'text-amber-300' : flag ? 'text-zinc-300' : 'text-zinc-500'}`}>
              {flag ? flag.context : status}
              {owner && <span className="text-zinc-500"> · {owner.name}</span>}
            </span>
          </span>
          <span className="flex items-center gap-2.5 flex-shrink-0">
            {subtask.due_date && (
              <span className={`text-xs tabular-nums ${late ? 'text-red-400 font-medium' : 'text-zinc-500'}`}>
                {late && <span className="sr-only">Overdue </span>}
                {shortDate(subtask.due_date)}
              </span>
            )}
            {owner && <Avatar name={owner.name} src={owner.avatar || undefined} size="xs" />}
            {flag?.onOpen && <ChevronRight size={14} className="text-zinc-600" aria-hidden="true" />}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="pb-2">
      {/* The ring and the tray's rings line up with the parent's title, 60px
          in (px-4, the 32px icon square, gap-3). */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={trayId}
        className="group/subtasks flex items-center gap-2 ml-[52px] px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <SubtaskRing done={progress.done} total={progress.total} size={14} />
        <span className="tabular-nums">
          <span className={progress.done === progress.total ? 'text-emerald-300' : ''}>{progress.done} of {progress.total}</span> subtasks done
        </span>
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul id={trayId} aria-label={`Subtasks of ${parent.title}`} className="ml-[44px] mr-4 mt-1 mb-1 rounded-[10px] bg-white/[0.04] p-1">
          {ordered.map(subtaskRow)}
        </ul>
      )}
    </div>
  );
}
