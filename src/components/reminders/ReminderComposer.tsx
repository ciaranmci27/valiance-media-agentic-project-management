'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { TimeInput } from '@/components/ui/inputs/TimeInput';
import { addDays, dayKey, nextMonday } from '@/lib/reminders';

export interface ReminderDraft {
  title: string;
  remind_on: string | null;
  remind_at: string | null;
}

interface ReminderComposerProps {
  onAdd: (draft: ReminderDraft) => void;
  placeholder?: string;
  /** Start with the date row showing (the Reminders page). */
  expanded?: boolean;
}

/**
 * Type the step, press Enter. A date and a time are optional: the date row
 * appears once there is text, with one-tap Today / Tomorrow / Monday.
 */
export function ReminderComposer({ onAdd, placeholder = 'Add a reminder...', expanded = false }: ReminderComposerProps) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');

  const showWhen = expanded || title.trim().length > 0 || !!date;
  const today = dayKey(new Date());
  const quick = [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: 'Monday', value: nextMonday(new Date()) },
  ];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd({ title: title.trim(), remind_on: date || null, remind_at: date && time ? `${time}:00` : null });
    setTitle('');
    setDate('');
    setTime('');
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex items-center gap-2">
        <TextInput
          value={title}
          onChange={setTitle}
          placeholder={placeholder}
          aria-label="New reminder"
          size="sm"
          className="flex-1"
        />
        <button
          type="submit"
          aria-label="Add reminder"
          disabled={!title.trim()}
          className="p-1 rounded text-zinc-500 hover:text-brand-300 hover:bg-brand-500/15 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>

      {showWhen && (
        <div className="flex flex-wrap items-center gap-1.5">
          {quick.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => setDate(date === q.value ? '' : q.value)}
              aria-pressed={date === q.value}
              className={`px-2 py-1 rounded-md text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                date === q.value
                  ? 'bg-brand-500/20 text-brand-200'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]'
              }`}
            >
              {q.label}
            </button>
          ))}
          <DateInput
            value={date}
            onChange={(v) => { setDate(v); if (!v) setTime(''); }}
            placeholder="Pick a date"
            ariaLabel="Reminder date"
            size="sm"
            clearable
            className="w-36"
          />
          {date && (
            <div className="flex items-center gap-1">
              <TimeInput value={time} onChange={setTime} placeholder="Any time" size="sm" minuteStep={15} className="w-28" />
              {time && (
                <button
                  type="button"
                  onClick={() => setTime('')}
                  aria-label="Remove the time"
                  className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          {!date && <span className="text-xs text-zinc-500">No date: it waits on the list.</span>}
        </div>
      )}
    </form>
  );
}
