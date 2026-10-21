'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Reminder } from '@/lib/types';
import { compareReminders, reminderGroup, REMINDER_GROUP_LABELS, type ReminderGroup } from '@/lib/reminders';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { ReminderRow } from './ReminderRow';

const OPEN_GROUPS: ReminderGroup[] = ['overdue', 'today', 'upcoming', 'no_date'];

const DOT: Partial<Record<ReminderGroup, string>> = {
  overdue: '#f87171',
  today: 'var(--color-brand-500)',
};

interface ReminderGroupsProps {
  reminders: Reminder[];
  /** Name each reminder's task or project. */
  showContext?: boolean;
  /** 'page': a card per group. 'panel': plain groups inside a panel. */
  variant?: 'page' | 'panel';
  /** Inside one project's page: its name is not repeated on each row. */
  withinProjectId?: string;
}

/**
 * Reminders in the order they need attention: Overdue, Today, Upcoming,
 * No date, with the last 30 days of Done folded away at the end.
 */
export function ReminderGroups({ reminders, showContext = true, variant = 'page', withinProjectId }: ReminderGroupsProps) {
  const [showDone, setShowDone] = useState(false);
  const now = new Date();
  const sorted = [...reminders].sort(compareReminders);
  const byGroup = (group: ReminderGroup) => sorted.filter(r => reminderGroup(r, now) === group);
  const done = byGroup('done');

  const list = (rows: Reminder[]) => (
    <div className={variant === 'page' ? 'glass-card rounded-xl p-1.5' : 'space-y-0.5'}>
      {rows.map(r => <ReminderRow key={r.id} reminder={r} showContext={showContext} withinProjectId={withinProjectId} />)}
    </div>
  );

  return (
    <div className={variant === 'page' ? 'space-y-6' : 'space-y-4'}>
      {OPEN_GROUPS.map(group => {
        const rows = byGroup(group);
        if (rows.length === 0) return null;
        return (
          <section key={group} aria-label={REMINDER_GROUP_LABELS[group]}>
            <SectionHeader label={REMINDER_GROUP_LABELS[group]} count={rows.length} dotColor={DOT[group]} className={variant === 'panel' ? 'mb-1.5' : ''} />
            {list(rows)}
          </section>
        );
      })}

      {done.length > 0 && (
        <section aria-label="Done">
          <button
            type="button"
            onClick={() => setShowDone(v => !v)}
            aria-expanded={showDone}
            className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider hover:text-zinc-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronRight size={12} className={`transition-transform ${showDone ? 'rotate-90' : ''}`} aria-hidden="true" />
            Done
            <span className="text-[11px] font-medium normal-case tracking-normal leading-none px-1.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-400 tabular-nums">
              {done.length}
            </span>
          </button>
          {showDone && list(done)}
        </section>
      )}
    </div>
  );
}
