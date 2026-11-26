'use client';

import { useRef, useState } from 'react';
import { Repeat, Undo2 } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { setReadData } from '@/lib/query-cache';
import { schedulesRead } from '@/lib/reads';
import { workspaceApi } from '@/lib/agent-workspace';
import {
  defaultRecurrence, recurrenceSchema, repeatsLabel, scheduleDateLabel, upcomingDates, type Recurrence, type RepeatMode, type ScheduleView,
} from '@/lib/schedules';
import type { Task } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { toast } from '@/components/ui/Toast';
import { DetailRow } from '@/components/tasks/TaskFields';
import { RecurrencePicker } from './RecurrencePicker';
import { dismissRemoved, errorText, refreshSchedules, removeSchedule, todayIn, undoRemoveSchedule, useRemovedSchedules, useTaskRepeat } from './schedule-actions';

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const MODE_OPTIONS: { value: RepeatMode; label: string; description: string }[] = [
  { value: 'schedule', label: 'On schedule', description: 'The next copy appears when this one falls due.' },
  { value: 'after_done', label: "After it's done", description: 'The next copy appears when you finish this one, due on the next date after that day.' },
];

/**
 * The task panel's Repeat row (top-level tasks only): "Repeats every
 * Monday", or "Does not repeat". Clicking it opens the pattern, when the next
 * copy appears (on schedule, or once this one is done) and an optional end.
 * Stop repeating acts at once and leaves Undo in place. Someone who cannot
 * edit the task sees the repeat, or nothing when there is none.
 */
export function TaskRepeatRow({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const repeat = useTaskRepeat(task.id);
  const stopped = useRemovedSchedules().find((s) => s.kind === 'task' && s.task_id === task.id);
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  if (!canEdit && !repeat) return null;

  const label = repeat ? repeatsLabel(repeat.recurrence) : 'Does not repeat';
  const shown = (
    <span className={`flex min-w-0 items-center gap-1.5 ${repeat ? 'text-zinc-200' : 'text-zinc-500'}`}>
      <span className="truncate">{label}</span>
      {repeat?.status === 'paused' && <span className="flex-shrink-0 rounded-full bg-amber-500/[0.14] px-1.5 py-px text-[10px] font-medium text-amber-300">Paused</span>}
    </span>
  );

  const undo = async () => {
    if (!stopped) return;
    try { await undoRemoveSchedule(stopped); toast('success', 'Repeats again'); } catch (error) { toast('error', errorText(error, 'Could not bring the repeat back')); }
  };

  return (
    <DetailRow icon={Repeat} label="Repeat">
      {stopped && !repeat ? (
        <span role="status" className="flex min-w-0 items-center gap-2 text-sm text-zinc-300">
          <span className="truncate">Stopped repeating.</span>
          <button type="button" onClick={() => void undo()} className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-brand-300 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Undo2 size={12} aria-hidden="true" />Undo
          </button>
          <button type="button" onClick={() => dismissRemoved(stopped.id)} aria-label="Dismiss" className="flex-shrink-0 rounded-md px-1 text-xs text-zinc-500 hover:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Dismiss</button>
        </span>
      ) : !canEdit ? (
        <div className="min-w-0 flex-1 py-0.5 text-sm">{shown}</div>
      ) : (
        <div ref={anchor} className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`${label}. Click to change`}
            className="block w-full rounded-md -mx-1.5 px-1.5 py-0.5 text-left text-sm transition-colors hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {shown}
          </button>
          <Popover
            anchorRef={anchor}
            open={open}
            onClose={() => setOpen(false)}
            align="start"
            width={368}
            ignoreOutsideSelector="[popover]"
            className="rounded-xl border border-white/[0.08] bg-surface-overlay shadow-[var(--shadow-overlay)]"
          >
            <RepeatEditor key={repeat?.id ?? 'new'} task={task} repeat={repeat} onDone={() => setOpen(false)} />
          </Popover>
        </div>
      )}
    </DetailRow>
  );
}

function RepeatEditor({ task, repeat, onDone }: { task: Task; repeat: ScheduleView | null; onDone: () => void }) {
  const { team, updateTask } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const memberZone = team.find((m) => m.id === teamMemberId)?.timezone;
  const timeZone = repeat?.timezone ?? (memberZone && memberZone !== 'UTC' ? memberZone : browserZone());
  const today = todayIn(timeZone);
  // Copies count from the task's due date; a task without one takes the pattern's first date.
  const startDate = task.due_date ?? today;
  const [recurrence, setRecurrence] = useState<Recurrence>(() => repeat?.recurrence ?? defaultRecurrence(startDate));
  const [mode, setMode] = useState<RepeatMode>(repeat?.mode ?? 'schedule');
  const [endDate, setEndDate] = useState(repeat?.end_date ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = recurrenceSchema.safeParse(recurrence);
  const firstDate = !task.due_date && parsed.success ? (() => { try { return upcomingDates(parsed.data, today, today, 1)[0] ?? null; } catch { return null; } })() : null;
  const endProblem = endDate && endDate < startDate ? 'The end date is before the task is due.' : null;
  const unchanged = !!repeat && JSON.stringify(repeat.recurrence) === JSON.stringify(recurrence) && repeat.mode === mode && (repeat.end_date ?? '') === endDate;

  const save = async () => {
    if (busy || isDemoMode || !parsed.success || endProblem) return;
    setBusy(true);
    setError(null);
    try {
      const result = await workspaceApi<{ repeat: ScheduleView; due_date: string | null; due_date_set: boolean }>(
        `/api/workspace/tasks/${encodeURIComponent(task.id)}/repeat`,
        { method: 'PUT', body: { recurrence: parsed.data, mode, timezone: timeZone, end_date: endDate || null } },
      );
      // Show it on the cards at once, then read the list fresh.
      setReadData(schedulesRead(false, 'task'), (current) => ({
        schedules: [result.repeat, ...(current?.schedules ?? []).filter((s) => s.id !== result.repeat.id && s.task_id !== task.id)],
        total: (current?.total ?? 0) + (repeat ? 0 : 1),
        scheduler_ready: current?.scheduler_ready ?? true,
      }));
      refreshSchedules();
      // The server set the due date (the task had none): show it here at once.
      if (result.due_date_set && result.due_date && result.due_date !== task.due_date) await updateTask(task.id, { due_date: result.due_date }, { silent: true });
      toast('success', result.due_date_set && result.due_date ? `${repeatsLabel(result.repeat.recurrence)}, first due ${scheduleDateLabel(result.due_date, false)}` : repeatsLabel(result.repeat.recurrence));
      onDone();
    } catch (err) {
      setError(errorText(err, 'Could not save the repeat'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!repeat || isDemoMode) return;
    onDone();
    try { await removeSchedule(repeat); } catch (err) { toast('error', errorText(err, 'Could not stop the repeat')); }
  };

  return (
    // The popover caps its height to the space on screen; the actions stay pinned
    // below the scrolling fields, so Save is always in view on a phone.
    <div className="flex max-h-[inherit] flex-col" role="group" aria-labelledby={`repeat-title-${task.id}`}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div>
        <p id={`repeat-title-${task.id}`} className="text-sm font-semibold text-white">Repeat this task</p>
        <p className="mt-0.5 text-xs text-zinc-400">Each copy keeps the title, description, assignees, project, tags and priority. Subtasks come back unchecked.</p>
      </div>

      <RecurrencePicker value={recurrence} onChange={setRecurrence} startDate={startDate} timeZone={timeZone} endDate={endDate || null} />

      <RadioGroup<RepeatMode> label="Next copy" value={mode} onChange={setMode} options={MODE_OPTIONS} />

      <DateInput label="Ends" value={endDate} onChange={setEndDate} placeholder="No end date" clearable minDate={startDate} error={endProblem ?? undefined} />

      {!task.due_date && firstDate && (
        <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-300">This task has no due date. Saving sets it to {scheduleDateLabel(firstDate, false)}, the first date.</p>
      )}
      {isDemoMode && <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-400">The demo does not save repeats.</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      </div>

      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3">
        {repeat ? (
          <Button variant="ghost" size="sm" onClick={() => void stop()} disabled={isDemoMode} className="!text-red-300">Stop repeating</Button>
        ) : <span />}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || isDemoMode || !parsed.success || !!endProblem || unchanged}>
            {busy ? 'Saving' : repeat ? 'Save' : 'Repeat'}
          </Button>
        </div>
      </div>
    </div>
  );
}
