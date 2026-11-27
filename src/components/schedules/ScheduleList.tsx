'use client';

import { useState } from 'react';
import { CalendarClock, Edit, Eye, Info, Pause, Play, RefreshCw, Repeat, Trash2, Undo2 } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { schedulesRead } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import { occurrenceLabel, type ScheduleView } from '@/lib/schedules';
import { Button } from '@/components/ui/Button';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { toast } from '@/components/ui/Toast';
import {
  dismissRemoved, errorText, removeSchedule, scheduleStatusLine, setSchedulePaused, undoRemoveSchedule, useRemovedSchedules,
} from './schedule-actions';

const PAGE = 10;

/** "Last run Nov 1", "Skipped yesterday: the previous run still has open tasks", "Failed Nov 1", or "No runs yet". */
export function lastOutcomeLabel(schedule: Pick<ScheduleView, 'last_outcome' | 'last_reason' | 'last_run_at'>): string {
  if (!schedule.last_outcome) return 'No runs yet';
  if (schedule.last_outcome === 'running') return 'Running now';
  const ago = schedule.last_run_at ? timeAgo(schedule.last_run_at) : '';
  // "Just now" and "Yesterday" read mid-sentence in lower case; dates keep theirs.
  const when = ago && /^(Just|Yesterday)/.test(ago) ? ` ${ago.toLowerCase()}` : ago ? ` ${ago}` : '';
  if (schedule.last_outcome === 'created') return `Last run${when}`;
  const [head, ...rest] = occurrenceLabel({ status: schedule.last_outcome, reason: schedule.last_reason }).split(': ');
  return `${head}${when}${rest.length ? `: ${rest.join(': ')}` : ''}`;
}

/**
 * Settings > Templates' Schedules: every template that runs on its own, one
 * row each (the template, how often, where, the next run, what the last run
 * did) with Pause or Resume at hand and Edit and Remove in the row menu.
 * A removal acts at once and leaves an Undo line in its place.
 */
export function ScheduleList({ onOpen }: { onOpen: (schedule: ScheduleView) => void }) {
  const { isDemoMode } = useDemo();
  const list = useRead(schedulesRead(isDemoMode, 'template'));
  const removed = useRemovedSchedules().filter((s) => s.kind === 'template');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = list.data?.schedules ?? [];
  const visible = rows.slice(0, limit);

  const togglePaused = async (schedule: ScheduleView) => {
    if (isDemoMode || busy) return;
    setBusy(schedule.id);
    try {
      const result = await setSchedulePaused(schedule, schedule.status !== 'paused');
      toast('success', result.status === 'paused' ? `Paused ${schedule.template_name ?? 'the schedule'}` : `Resumed ${schedule.template_name ?? 'the schedule'}`);
    } catch (error) {
      toast('error', errorText(error, 'Could not change the schedule'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (schedule: ScheduleView) => {
    if (isDemoMode) return;
    try { await removeSchedule(schedule); } catch (error) { toast('error', errorText(error, 'Could not remove the schedule')); }
  };
  const undo = async (schedule: ScheduleView) => {
    try { await undoRemoveSchedule(schedule); toast('success', 'Schedule is back'); } catch (error) { toast('error', errorText(error, 'Could not bring the schedule back')); }
  };

  const actionsFor = (schedule: ScheduleView): RowAction[] => {
    const editable = schedule.can_edit && !isDemoMode;
    const out: RowAction[] = [editable
      ? { label: 'Edit', icon: <Edit size={14} />, onClick: () => onOpen(schedule) }
      : { label: 'Open', icon: <Eye size={14} />, onClick: () => onOpen(schedule) }];
    if (editable) out.push({ label: 'Remove', icon: <Trash2 size={14} />, variant: 'danger', divider: true, onClick: () => void remove(schedule) });
    return out;
  };

  return (
    <div>
      <div className="mb-3">
        <h3 id="schedules-heading" className="flex items-center gap-2 text-sm font-semibold text-white">
          Schedules
          {rows.length > 0 && <span className="text-xs font-normal tabular-nums text-zinc-400">{rows.length}</span>}
        </h3>
        <p className="mt-0.5 text-xs text-zinc-400">Templates that run on their own, on the dates you set. Pick Schedule in a template&apos;s menu to add one.</p>
      </div>

      {list.data && !list.data.scheduler_ready && (
        <p role="status" className="mb-3 flex items-start gap-2 rounded-lg bg-amber-500/[0.1] px-3 py-2 text-xs text-amber-300">
          <Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          Schedules are saved but do not run on their own yet: the database cannot wake the app. Whoever runs this install can finish the setup.
        </p>
      )}

      {removed.length > 0 && (
        <ul className="mb-3 space-y-1.5" aria-label="Removed schedules">
          {removed.map((schedule) => (
            <li key={schedule.id} role="status" className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">
              <span className="min-w-0 truncate">Removed the {schedule.template_name ?? 'template'} schedule.</span>
              <span className="flex flex-shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" icon={<Undo2 size={13} aria-hidden="true" />} onClick={() => void undo(schedule)}>Undo</Button>
                <button type="button" onClick={() => dismissRemoved(schedule.id)} className="rounded px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Dismiss</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {list.failed && !list.data ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg bg-white/[0.03] py-8 text-center">
          <p className="text-sm text-zinc-300">Could not load the schedules.</p>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={list.reload}>Try again</Button>
        </div>
      ) : !list.data ? (
        <div role="status" aria-label="Loading schedules" className="space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-14 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-4 py-5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-zinc-400" aria-hidden="true"><Repeat size={15} /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-200">No schedules yet</p>
            <p className="text-xs text-zinc-400">A template can run every week or month by itself: open its menu and pick Schedule.</p>
          </div>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]" aria-labelledby="schedules-heading">
            {visible.map((schedule) => {
              const paused = schedule.status === 'paused';
              const facts = [schedule.project_name, scheduleStatusLine(schedule), lastOutcomeLabel(schedule)].filter(Boolean) as string[];
              return (
                <li key={schedule.id} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={`mt-0.5 hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg sm:flex ${paused ? 'bg-amber-500/[0.14] text-amber-300' : 'bg-brand-500/15 text-brand-300'}`}
                    aria-hidden="true"
                  >
                    {paused ? <Pause size={15} /> : <CalendarClock size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <button
                        type="button"
                        onClick={() => onOpen(schedule)}
                        className="min-w-0 max-w-full truncate rounded text-left text-sm font-semibold text-white transition-colors hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        {schedule.template_name ?? 'A template'}
                      </button>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2 py-0.5 text-[11px] text-zinc-300">
                        <Repeat size={11} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                        {schedule.recurrence_label}
                      </span>
                    </div>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
                      {facts.map((fact, i) => (
                        <span key={fact} className={`min-w-0 max-w-full truncate ${i === 1 && paused ? 'text-amber-300' : ''}`}>{fact}</span>
                      ))}
                    </p>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {schedule.can_edit && schedule.status !== 'ended' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                        onClick={() => void togglePaused(schedule)}
                        disabled={isDemoMode || busy === schedule.id}
                        aria-label={`${paused ? 'Resume' : 'Pause'} ${schedule.template_name ?? 'schedule'}`}
                      >
                        <span className="hidden sm:inline">{paused ? 'Resume' : 'Pause'}</span>
                      </Button>
                    )}
                    <RowActionsMenu actions={actionsFor(schedule)} label={`Actions for the ${schedule.template_name ?? 'template'} schedule`} />
                  </div>
                </li>
              );
            })}
          </ul>
          {rows.length > visible.length && (
            <Button variant="ghost" size="sm" className="mt-2 -ml-2.5" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - visible.length)} more of {rows.length - visible.length}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
