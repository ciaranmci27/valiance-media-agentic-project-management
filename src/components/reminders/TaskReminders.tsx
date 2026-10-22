'use client';

import { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { compareReminders } from '@/lib/reminders';
import { ReminderRow } from './ReminderRow';
import { ReminderComposer } from './ReminderComposer';

/**
 * A task's next steps: what still has to happen for it to move, with the
 * finished ones folded away. Anyone who can see the task can add one. The
 * task panel's Reminders section supplies the heading.
 */
export function TaskReminders({ task }: { task: Task }) {
  const { reminders, addReminder } = useApp();
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);

  const mine = reminders.filter(r => r.task_id === task.id).sort(compareReminders);
  const open = mine.filter(r => r.status === 'open');
  const done = mine.filter(r => r.status === 'done');

  return (
    <div className="space-y-1">
      {open.length > 0 && (
        <div className="space-y-0.5 -mx-2">
          {open.map(r => <ReminderRow key={r.id} reminder={r} />)}
        </div>
      )}

      {adding ? (
        <ReminderComposer
          onAdd={(draft) => void addReminder({ ...draft, task_id: task.id, project_id: task.project_id })}
          placeholder="What has to happen next"
          autoFocus
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full flex items-center gap-2 -mx-2 px-2 py-1.5 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Plus size={16} aria-hidden="true" />
          Add reminder
        </button>
      )}

      {done.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setShowDone(v => !v)}
            aria-expanded={showDone}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronRight size={12} className={`transition-transform ${showDone ? 'rotate-90' : ''}`} aria-hidden="true" />
            Done ({done.length})
          </button>
          {showDone && (
            <div className="mt-1 space-y-0.5 -mx-2">
              {done.map(r => <ReminderRow key={r.id} reminder={r} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
