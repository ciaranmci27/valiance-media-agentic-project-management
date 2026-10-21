'use client';

import Link from 'next/link';
import { BellRing } from 'lucide-react';
import { useApp } from '@/lib/store';
import { ReminderComposer } from './ReminderComposer';
import { ReminderGroups } from './ReminderGroups';

/**
 * A project's reminders: its own (follow up with the client, renew the
 * domain) and every task's next step, so nothing on the project is only in
 * someone's head. New ones added here belong to the project.
 */
export function ProjectReminders({ projectId }: { projectId: string }) {
  const { reminders, addReminder } = useApp();
  const mine = reminders.filter(r => r.project_id === projectId);
  const open = mine.filter(r => r.status === 'open').length;

  return (
    <section className="glass-card rounded-xl flex flex-col max-h-[520px]" aria-labelledby={`project-reminders-${projectId}`}>
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-white/[0.08] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <BellRing size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h2 id={`project-reminders-${projectId}`} className="font-semibold text-white truncate">Reminders</h2>
          {open > 0 && (
            <span className="text-[11px] font-medium leading-none px-1.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-400 tabular-nums">{open}</span>
          )}
        </div>
        <Link
          href={`/reminders?project=${projectId}`}
          className="text-xs text-zinc-400 hover:text-zinc-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          All reminders
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <ReminderComposer
          placeholder="Add a reminder for this project..."
          onAdd={(draft) => void addReminder({ ...draft, project_id: projectId })}
        />
        {mine.length > 0 ? (
          <ReminderGroups reminders={mine} variant="panel" withinProjectId={projectId} />
        ) : (
          <p className="text-xs text-zinc-500">
            Follow-ups for the project, and the next step of any task here, show up in this list.
          </p>
        )}
      </div>
    </section>
  );
}
