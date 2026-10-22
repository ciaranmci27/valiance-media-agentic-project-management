'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, CalendarClock, CalendarX, Sunrise, CalendarDays, Trash2, Pencil } from 'lucide-react';
import type { Reminder } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { canManageAllTasks } from '@/lib/access-control';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { ReminderWhenEditor } from './ReminderWhenEditor';
import { Avatar } from '@/components/ui/Avatar';
import { Tooltip } from '@/components/ui/Tooltip';
import { addDays, dayKey, nextMonday, reminderGroup, whenLabel } from '@/lib/reminders';

const WHEN_TONE = {
  overdue: 'text-red-400',
  today: 'text-brand-300',
  upcoming: 'text-zinc-400',
  no_date: 'text-zinc-500',
  done: 'text-zinc-500',
} as const;

interface ReminderRowProps {
  reminder: Reminder;
  /** Name the task or project it belongs to (lists outside that task). */
  showContext?: boolean;
  /** The project the list is already inside: its name is not repeated. */
  withinProjectId?: string;
  /** 'compact' for the task panel and pop-ups; 'band' for a My Tasks band. */
  variant?: 'compact' | 'band';
  /** Opens the reminder's task (band rows); without it the title is plain text. */
  onOpenTask?: (taskId: string) => void;
}

export function ReminderRow({ reminder, showContext = false, withinProjectId, variant = 'compact', onOpenTask }: ReminderRowProps) {
  const { updateReminder, deleteReminder, tasks, getProject, getTeamMember } = useApp();
  const { teamMemberId, access } = useAuth();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(reminder.title);
  const [editingWhen, setEditingWhen] = useState(false);

  const done = reminder.status === 'done';
  const group = reminderGroup(reminder);
  const when = whenLabel(reminder);
  const canDelete = reminder.owner_id === teamMemberId || reminder.created_by === teamMemberId || canManageAllTasks(access);
  const owner = reminder.owner_id !== teamMemberId ? getTeamMember(reminder.owner_id) : undefined;
  const task = showContext && reminder.task_id ? tasks.find(t => t.id === reminder.task_id) : undefined;
  const project = showContext && reminder.project_id && reminder.project_id !== withinProjectId ? getProject(reminder.project_id) : undefined;

  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== reminder.title) void updateReminder(reminder.id, { title: next });
    else setTitle(reminder.title);
    setEditingTitle(false);
  };

  const openWhenEditor = () => setEditingWhen(true);

  const saveWhen = (when: { remind_on: string | null; remind_at: string | null }) => {
    void updateReminder(reminder.id, when);
    setEditingWhen(false);
  };

  const snooze = (on: string) => void updateReminder(reminder.id, { remind_on: on, remind_at: reminder.remind_at });

  const today = dayKey(new Date());
  const actions: RowAction[] = [
    { label: 'Edit text', icon: <Pencil size={14} />, onClick: () => { setTitle(reminder.title); setEditingTitle(true); } },
    { label: reminder.remind_on ? 'Change date' : 'Add a date', icon: <CalendarClock size={14} />, onClick: openWhenEditor },
    ...(!done ? [
      { label: 'Tomorrow', icon: <Sunrise size={14} />, onClick: () => snooze(addDays(today, 1)), divider: true },
      { label: 'Next Monday', icon: <CalendarDays size={14} />, onClick: () => snooze(nextMonday(new Date())) },
    ] : []),
    ...(reminder.remind_on ? [{ label: 'Remove the date', icon: <CalendarX size={14} />, onClick: () => void updateReminder(reminder.id, { remind_on: null }) }] : []),
    ...(canDelete ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, onClick: () => void deleteReminder(reminder.id), variant: 'danger' as const, divider: true }] : []),
  ];

  // My Tasks rows: the page's one row anatomy (icon square, title over a
  // context line, meta on the right). The square is the tick-off button.
  if (variant === 'band') {
    const bandTask = reminder.task_id ? tasks.find(t => t.id === reminder.task_id) : undefined;
    const bandProject = reminder.project_id ? getProject(reminder.project_id) : undefined;
    const tone = done
      ? 'bg-emerald-500/15 text-emerald-300'
      : group === 'overdue'
        ? 'bg-red-500/15 text-red-300'
        : group === 'today' ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.06] text-zinc-400';
    const context = bandTask ? `Next step on ${bandTask.title}` : bandProject ? 'Project follow-up' : 'No project';
    return (
      <div className="group flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors">
        <button
          type="button"
          onClick={() => void updateReminder(reminder.id, { status: done ? 'open' : 'done' })}
          aria-pressed={done}
          aria-label={done ? `Mark "${reminder.title}" not done` : `Mark "${reminder.title}" done`}
          className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors hover:ring-1 hover:ring-emerald-400/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${tone}`}
        >
          {done
            ? <Check size={15} aria-hidden="true" />
            : <span className="w-3.5 h-3.5 rounded-full border-2 border-current" aria-hidden="true" />}
        </button>

        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <form onSubmit={(e) => { e.preventDefault(); saveTitle(); }}>
              <TextInput value={title} onChange={setTitle} onBlur={saveTitle} autoFocus size="sm" aria-label="Reminder text" />
            </form>
          ) : bandTask && onOpenTask ? (
            <button
              type="button"
              onClick={() => onOpenTask(bandTask.id)}
              className={`block max-w-full text-left text-sm font-medium truncate rounded hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${done ? 'text-zinc-500 line-through' : 'text-white'}`}
            >
              {reminder.title}
            </button>
          ) : (
            <span className={`block text-sm font-medium truncate ${done ? 'text-zinc-500 line-through' : 'text-white'}`}>{reminder.title}</span>
          )}
          {editingWhen ? (
            <ReminderWhenEditor
              remindOn={reminder.remind_on}
              remindAt={reminder.remind_at}
              onSave={saveWhen}
              onCancel={() => setEditingWhen(false)}
            />
          ) : (
            <span className="flex items-center gap-1.5 mt-0.5 min-w-0 text-xs text-zinc-500">
              {bandProject && (
                <>
                  {bandProject.color && (
                    <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: bandProject.color }} aria-hidden="true" />
                  )}
                  <span className="truncate flex-shrink-0 max-w-[180px] text-zinc-400">{bandProject.name}</span>
                  <span className="text-zinc-600" aria-hidden="true">·</span>
                </>
              )}
              <span className="truncate">{context}</span>
            </span>
          )}
        </div>

        <span className="flex items-center gap-2 flex-shrink-0">
          {done ? (
            <span className="text-xs text-zinc-500">{reminder.closed_by_task ? 'Closed with the task' : 'Done'}</span>
          ) : when && !editingWhen && (
            <button
              type="button"
              onClick={openWhenEditor}
              className={`text-xs tabular-nums rounded hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${WHEN_TONE[group]} ${group === 'overdue' ? 'font-medium' : ''}`}
            >
              {group === 'overdue' ? `Overdue ${when}` : when}
            </button>
          )}
          <RowActionsMenu
            actions={actions}
            label={`Actions for reminder ${reminder.title}`}
            triggerClassName="lg:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
          />
        </span>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 p-2 rounded-lg hover:bg-white/[0.03]">
      <button
        type="button"
        onClick={() => void updateReminder(reminder.id, { status: done ? 'open' : 'done' })}
        aria-pressed={done}
        aria-label={done ? `Mark "${reminder.title}" not done` : `Mark "${reminder.title}" done`}
        className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] ${
          done ? 'bg-emerald-500 border-emerald-500' : 'border-white/[0.18] hover:border-emerald-400'
        }`}
      >
        {done && <Check size={12} className="text-white" aria-hidden="true" />}
      </button>

      <div className="flex-1 min-w-0">
        {editingTitle ? (
          <form onSubmit={(e) => { e.preventDefault(); saveTitle(); }}>
            <TextInput value={title} onChange={setTitle} onBlur={saveTitle} autoFocus size="sm" aria-label="Reminder text" />
          </form>
        ) : (
          <p className={`text-sm leading-snug break-words ${done ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
            {reminder.title}
          </p>
        )}

        {editingWhen ? (
          <ReminderWhenEditor
            remindOn={reminder.remind_on}
            remindAt={reminder.remind_at}
            onSave={saveWhen}
            onCancel={() => setEditingWhen(false)}
          />
        ) : (when || done || task || project || owner) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            {done ? (
              <span className="text-zinc-500">{reminder.closed_by_task ? 'Closed with the task' : 'Done'}</span>
            ) : when && (
              <button type="button" onClick={openWhenEditor} className={`${WHEN_TONE[group]} hover:underline underline-offset-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}>
                {group === 'overdue' ? `Overdue: ${when}` : when}
              </button>
            )}
            {task ? (
              <Link href={`/projects/${task.project_id}?task=${task.id}`} className="text-zinc-400 hover:text-zinc-200 truncate max-w-[16rem] rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                {task.title}
              </Link>
            ) : project && (
              <Link href={`/projects/${project.id}`} className="text-zinc-400 hover:text-zinc-200 truncate max-w-[16rem] rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                {project.name}
              </Link>
            )}
            {owner && (
              <Tooltip content={`${owner.name}'s reminder`}>
                <span className="inline-flex items-center gap-1 text-zinc-500">
                  <Avatar name={owner.name} src={owner.avatar || undefined} size="xs" />
                  <span className="sr-only">{owner.name}&apos;s reminder</span>
                </span>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      <RowActionsMenu
        actions={actions}
        label={`Actions for reminder ${reminder.title}`}
        triggerClassName="flex-shrink-0 -mr-1 -mt-0.5 lg:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
      />
    </div>
  );
}
