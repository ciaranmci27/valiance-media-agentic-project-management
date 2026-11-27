import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { apiKeyAllows } from './access';

/**
 * Readiness before work (pilot finding 2026-11-27): what in the app would
 * stop an agent's work on a project, said before it starts, so it is fixed
 * before the work is assigned instead of found halfway.
 *
 * - time_tracking_off: the agent tracks its time (its key and it hold
 *   time.manage_own) and the project tracks none (time_tracking_enabled and
 *   hourly_tracking both off), so a timer would be refused. An Owner or the
 *   project's manager turns time tracking on (an answer can do it:
 *   request_approval with action project.update).
 *
 * next_task carries can_start_work, skip_reason and blockers on the task it
 * picks; get_my_status lists blockers on the projects of the agent's open
 * work, and with project_id or task_id says can_start_work false for that
 * project. Server only.
 */

export type ReadinessReason = 'time_tracking_off';

export interface WorkBlocker {
  reason: ReadinessReason;
  project_id: string;
  project_name: string | null;
  hint: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const HINT = 'Time tracking is off on this project and your work needs a timer. Ask a person who manages the project to turn it on (request_approval with action type project.update and details { project_id, time_tracking_enabled: true }), then start.';

/** Whether the agent's work needs a timer: it tracks its time with this key. */
export const workNeedsTimer = (access: AccessContext, scopes: string[]) =>
  access.role === 'agent' && apiKeyAllows(access, scopes, 'time.manage_own');

/** The blockers on these projects for an agent whose work needs a timer (none when it needs none). */
export async function projectBlockers(db: SupabaseClient, projectIds: string[], needsTimer: boolean): Promise<WorkBlocker[]> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!needsTimer || ids.length === 0) return [];
  const { data, error } = await db.from('projects').select('id, name, time_tracking_enabled, hourly_tracking').in('id', ids).is('deleted_at', null);
  if (error) throw error;
  return ((data ?? []) as Row[])
    .filter((p) => p.time_tracking_enabled !== true && p.hourly_tracking !== true)
    .map((p) => ({ reason: 'time_tracking_off' as const, project_id: p.id as string, project_name: (p.name as string | null) ?? null, hint: HINT }));
}

/** The projects of an agent's open work (assigned, not done): where blockers matter now. */
export async function openWorkProjects(db: SupabaseClient, memberId: string): Promise<string[]> {
  const { data: assigned, error } = await db.from('task_assignees').select('task_id').eq('member_id', memberId).limit(500);
  if (error) throw error;
  const taskIds = ((assigned ?? []) as Row[]).map((row) => row.task_id as string);
  if (taskIds.length === 0) return [];
  const { data, error: tasksError } = await db.from('tasks').select('project_id').in('id', taskIds).neq('status', 'done').is('deleted_at', null);
  if (tasksError) throw tasksError;
  return [...new Set(((data ?? []) as Row[]).map((row) => row.project_id as string).filter(Boolean))];
}
