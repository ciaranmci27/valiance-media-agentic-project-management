'use client';

import { useState } from 'react';
import { BellRing, ChevronRight } from 'lucide-react';
import type { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { compareReminders } from '@/lib/reminders';
import { ReminderRow } from './ReminderRow';
import { ReminderComposer } from './ReminderComposer';

/**
 * A task's next steps: what still has to happen for it to move, with the
 * finished ones folded away. Anyone who can see the task can add one.
 */
export function TaskReminders({ task }: { task: Task }) {
  const { reminders, addReminder } = useApp();
  const [showDone, setShowDone] = useState(false);

  const mine = reminders.filter(r => r.task_id === task.id).sort(compareReminders);
  const open = mine.filter(r => r.status === 'open');
  const done = mine.filter(r => r.status === 'done');

  return (
    <section className="space-y-2" aria-labelledby={`task-reminders-${task.id}`}>
      <h3 id={`task-reminders-${task.id}`} className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <BellRing size={14} aria-hidden="true" />
        Reminders
        {open.length > 0 && <span className="text-xs text-zinc-400 font-normal">({open.length} open)</span>}
      </h3>

      {open.length === 0 && done.length === 0 && (
        <p className="text-xs text-zinc-500">The next step this task is waiting on, so it never stalls unnoticed.</p>
      )}

      {open.length > 0 && (
        <div className="space-y-0.5">
          {open.map(r => <ReminderRow key={r.id} reminder={r} />)}
        </div>
      )}

      <div className="pl-[22px]">
        <ReminderComposer
          onAdd={(draft) => void addReminder({ ...draft, task_id: task.id, project_id: task.project_id })}
          placeholder={open.length ? 'Add another reminder...' : 'Add a reminder...'}
        />
      </div>

      {done.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowDone(v => !v)}
            aria-expanded={showDone}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronRight size={12} className={`transition-transform ${showDone ? 'rotate-90' : ''}`} aria-hidden="true" />
            Done ({done.length})
          </button>
          {showDone && (
            <div className="mt-1 space-y-0.5">
              {done.map(r => <ReminderRow key={r.id} reminder={r} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
