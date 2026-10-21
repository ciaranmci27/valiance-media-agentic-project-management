'use client';

import { useRef, useState } from 'react';
import { BellRing } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Popover } from '@/components/ui/Popover';
import { compareReminders, reminderGroup } from '@/lib/reminders';
import { ReminderComposer } from './ReminderComposer';
import { ReminderRow } from './ReminderRow';

// Clicks in the pickers and row menus this pop-up opens stay inside it.
const NESTED_POPUPS = '[role="dialog"][aria-label="Date picker"], [role="dialog"][aria-label="Time picker"], [data-row-actions]';

/**
 * A project's open reminders behind one button beside the board: its own
 * follow-ups and every task's next step (each card shows its own too). New
 * ones added here belong to the project. Your reminders across projects live
 * on My Tasks.
 */
export function ProjectReminders({ projectId }: { projectId: string }) {
  const { reminders, addReminder } = useApp();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const list = reminders.filter(r => r.project_id === projectId && r.status === 'open').sort(compareReminders);
  const overdue = list.some(r => reminderGroup(r) === 'overdue');

  return (
    <div ref={anchorRef}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Reminders, ${list.length} open${overdue ? ', some overdue' : ''}`}
        className="h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-sm text-zinc-300 hover:text-white hover:bg-white/[0.06] border border-white/[0.08] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <BellRing size={16} className={overdue ? 'text-red-400' : undefined} aria-hidden="true" />
        <span className="hidden sm:inline">Reminders</span>
        {list.length > 0 && (
          <span className={`text-[11px] leading-none px-1.5 py-0.5 rounded-full tabular-nums ${overdue ? 'bg-red-500/15 text-red-300' : 'bg-white/[0.08] text-zinc-300'}`}>
            {list.length}
          </span>
        )}
      </button>

      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        width={400}
        ignoreOutsideSelector={NESTED_POPUPS}
        className="bg-surface-raised rounded-xl shadow-xl border border-white/[0.08] overflow-y-auto"
      >
        <div role="dialog" aria-label="Project reminders" className="p-3 space-y-3">
          <ReminderComposer
            placeholder="Add a reminder for this project..."
            onAdd={(draft) => void addReminder({ ...draft, project_id: projectId })}
          />
          {list.length > 0 ? (
            <div className="space-y-0.5 -mx-1">
              {list.map(r => <ReminderRow key={r.id} reminder={r} showContext withinProjectId={projectId} />)}
            </div>
          ) : (
            <p className="text-xs text-zinc-500 px-1">
              Nothing open. Follow-ups for the project, and the next step of any task here, show up in this list.
            </p>
          )}
        </div>
      </Popover>
    </div>
  );
}
