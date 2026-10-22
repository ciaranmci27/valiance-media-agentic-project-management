'use client';

import { useState } from 'react';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { TimeInput } from '@/components/ui/inputs/TimeInput';
import { Button } from '@/components/ui/Button';
import { toTimeInput } from '@/lib/reminders';

/** Every control in the editor is this tall, so the row lines up. */
const CONTROL = 'h-7 !py-0';

interface ReminderWhenEditorProps {
  remindOn: string | null;
  remindAt: string | null;
  onSave: (when: { remind_on: string | null; remind_at: string | null }) => void;
  onCancel: () => void;
}

/**
 * Change a reminder's date and time. The two fields stay together and the
 * two buttons stay together: on a narrow panel the buttons drop below as a
 * pair instead of Cancel wrapping on its own.
 */
export function ReminderWhenEditor({ remindOn, remindAt, onSave, onCancel }: ReminderWhenEditorProps) {
  const [date, setDate] = useState(remindOn ?? '');
  const [time, setTime] = useState(toTimeInput(remindAt));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ remind_on: date || null, remind_at: date && time ? `${time}:00` : null });
      }}
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <DateInput
          value={date}
          onChange={(v) => { setDate(v); if (!v) setTime(''); }}
          placeholder="No date"
          ariaLabel="Reminder date"
          size="sm"
          clearable
          className="w-36"
          inputClassName={CONTROL}
        />
        {date && (
          <TimeInput value={time} onChange={setTime} placeholder="Any time" size="sm" minuteStep={15} className="w-28" inputClassName={CONTROL} />
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" className={CONTROL}>Save</Button>
        <Button type="button" size="sm" variant="ghost" className={CONTROL} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
