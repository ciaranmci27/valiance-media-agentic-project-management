'use client';

import { useSyncExternalStore } from 'react';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { schedulesRead, SCHEDULE_TABLES } from '@/lib/reads';
import { useDemo } from '@/lib/demo-context';
import { dateInZone, OCCURRENCE_REASON_WORDS, scheduleDateLabel, type ScheduleView, type TemplateScheduleInput } from '@/lib/schedules';

/**
 * What every schedule screen does to a schedule: pause, resume, remove (at
 * once, with Undo in place: the list and the panel both show the line) and
 * undo a removal (made again with the same settings). After each write the
 * schedule reads refresh; schedules are not on the realtime feed.
 */

/** Today's date in a time zone (UTC when the zone is unknown). */
export function todayIn(timeZone: string): string {
  try { return dateInZone(Date.now(), timeZone); } catch { return dateInZone(Date.now(), 'UTC'); }
}

export const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export function refreshSchedules() {
  invalidateTables([...SCHEDULE_TABLES]);
}

const scheduleUrl = (id: string) => `/api/workspace/schedules/${encodeURIComponent(id)}`;

export async function setSchedulePaused(schedule: Pick<ScheduleView, 'id'>, paused: boolean): Promise<ScheduleView> {
  const result = await workspaceApi<ScheduleView>(scheduleUrl(schedule.id), { method: 'PATCH', body: { status: paused ? 'paused' : 'active' } });
  refreshSchedules();
  return result;
}

/** A template schedule's settings, as the create route takes them (to make it again). */
export function templateScheduleBody(schedule: ScheduleView): TemplateScheduleInput {
  return {
    project_id: schedule.project_id,
    recurrence: schedule.recurrence,
    timezone: schedule.timezone,
    start_date: schedule.start_date,
    end_date: schedule.end_date,
    roles: schedule.roles,
    values: schedule.values,
    key_date_offsets: schedule.key_date_offsets,
    create_initiative: schedule.create_initiative,
    skip_if_open: schedule.skip_if_open,
  };
}

// ── Removed, with Undo ──────────────────────────────────────────────────

let removed: ScheduleView[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Schedules removed this session that can still be brought back, newest first. */
export function useRemovedSchedules(): ScheduleView[] {
  return useSyncExternalStore(subscribe, () => removed, () => removed);
}

export function dismissRemoved(id: string) {
  removed = removed.filter((s) => s.id !== id);
  emit();
}

/** Removes a schedule at once: it never runs again; what it made stays. Its Undo line shows wherever it was. */
export async function removeSchedule(schedule: ScheduleView): Promise<void> {
  if (schedule.kind === 'task' && schedule.task_id) {
    await workspaceApi(`/api/workspace/tasks/${encodeURIComponent(schedule.task_id)}/repeat`, { method: 'DELETE' });
  } else {
    await workspaceApi(scheduleUrl(schedule.id), { method: 'DELETE' });
  }
  removed = [schedule, ...removed.filter((s) => s.id !== schedule.id)].slice(0, 10);
  emit();
  refreshSchedules();
}

/** Makes a removed schedule again with the same settings (a new id); paused ones come back paused. */
export async function undoRemoveSchedule(schedule: ScheduleView): Promise<ScheduleView> {
  let made: ScheduleView;
  if (schedule.kind === 'task' && schedule.task_id) {
    const result = await workspaceApi<{ repeat: ScheduleView }>(`/api/workspace/tasks/${encodeURIComponent(schedule.task_id)}/repeat`, {
      method: 'PUT',
      body: { recurrence: schedule.recurrence, mode: schedule.mode, timezone: schedule.timezone, end_date: schedule.end_date },
    });
    made = result.repeat;
  } else {
    if (!schedule.template_id) throw new Error('The template is gone, so this schedule cannot come back');
    made = await workspaceApi<ScheduleView>(`/api/workspace/task-templates/${encodeURIComponent(schedule.template_id)}/schedules`, {
      method: 'POST',
      body: templateScheduleBody(schedule),
    });
  }
  if (schedule.status === 'paused') made = await setSchedulePaused(made, true);
  dismissRemoved(schedule.id);
  refreshSchedules();
  return made;
}

// ── Words ───────────────────────────────────────────────────────────────

/** "Next run Mon, Dec 1", "Paused: it failed twice in a row", "Ended". */
export function scheduleStatusLine(schedule: ScheduleView, nextWord = 'Next run'): string {
  if (schedule.status === 'paused') {
    const why = schedule.paused_reason ? OCCURRENCE_REASON_WORDS[schedule.paused_reason] : null;
    return why ? `Paused: ${why}` : 'Paused';
  }
  if (schedule.status === 'ended') return 'Ended';
  if (!schedule.next_on) return schedule.kind === 'task' && schedule.mode === 'after_done' ? 'Next copy when this one is done' : 'No more dates';
  return `${nextWord} ${scheduleDateLabel(schedule.next_on, schedule.next_on.slice(0, 4) !== String(new Date().getFullYear()))}`;
}

// ── A task's repeat ─────────────────────────────────────────────────────

/**
 * The live repeat (active or paused) whose current task this is, or null.
 * One read of every task repeat, shared by every card and the task panel.
 */
export function useTaskRepeat(taskId: string | null | undefined): ScheduleView | null {
  const { isDemoMode } = useDemo();
  const list = useRead(taskId ? schedulesRead(isDemoMode, 'task') : null);
  if (!taskId) return null;
  return list.data?.schedules.find((s) => s.task_id === taskId && s.status !== 'ended') ?? null;
}
