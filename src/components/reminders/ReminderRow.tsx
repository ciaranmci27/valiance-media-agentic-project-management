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
import { DateInput } from '@/components/ui/inputs/DateInput';
import { TimeInput } from '@/components/ui/inputs/TimeInput';
import { Avatar } from '@/components/ui/Avatar';
import { Tooltip } from '@/components/ui/Tooltip';
import { addDays, dayKey, nextMonday, reminderGroup, toTimeInput, whenLabel } from '@/lib/reminders';

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
}

export function ReminderRow({ reminder, showContext = false, withinProjectId }: ReminderRowProps) {
  const { updateReminder, deleteReminder, tasks, getProject, getTeamMember } = useApp();
  const { teamMemberId, access } = useAuth();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(reminder.title);
  const [editingWhen, setEditingWhen] = useState(false);
  const [date, setDate] = useState(reminder.remind_on ?? '');
  const [time, setTime] = useState(toTimeInput(reminder.remind_at));

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

  const openWhenEditor = () => {
    setDate(reminder.remind_on ?? '');
    setTime(toTimeInput(reminder.remind_at));
    setEditingWhen(true);
  };

  const saveWhen = (e: React.FormEvent) => {
    e.preventDefault();
    void updateReminder(reminder.id, { remind_on: date || null, remind_at: date && time ? `${time}:00` : null });
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
    ...(canDelete ? [{ label: 'Delete', icon: <Trash2 size={14} />, onClick: () => void deleteReminder(reminder.id), variant: 'danger' as const, divider: true }] : []),
  ];

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
          <form onSubmit={saveWhen} className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <DateInput value={date} onChange={(v) => { setDate(v); if (!v) setTime(''); }} placeholder="No date" ariaLabel="Reminder date" size="sm" clearable className="w-36" />
            {date && <TimeInput value={time} onChange={setTime} placeholder="Any time" size="sm" minuteStep={15} className="w-28" />}
            <button type="submit" className="px-2 py-1 rounded-md text-xs font-medium bg-brand-500/20 text-brand-200 hover:bg-brand-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              Save
            </button>
            <button type="button" onClick={() => setEditingWhen(false)} className="px-2 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              Cancel
            </button>
          </form>
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
