import type { SupabaseClient } from '@supabase/supabase-js';
import { badRequest } from '@/lib/api/errors';
import { accessAllowsProject, resolveMemberAccess } from '@/lib/api/access';

/**
 * The ids among `ids` whose task is live (a subtask also needs its parent out
 * of Trash). Links (blockers, a time entry's tasks) keep pointing at a task in
 * Trash so a restore brings them back; reads leave those out.
 */
export async function liveTaskIds(supabase: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const { data, error } = await supabase.from('tasks').select('id, parent_task_id').in('id', unique).is('deleted_at', null);
  if (error) throw error;
  const rows = (data || []) as { id: string; parent_task_id: string | null }[];
  const parentIds = [...new Set(rows.flatMap((row) => (row.parent_task_id ? [row.parent_task_id] : [])))];
  let liveParents = new Set<string>();
  if (parentIds.length > 0) {
    const { data: parents, error: parentError } = await supabase.from('tasks').select('id').in('id', parentIds).is('deleted_at', null);
    if (parentError) throw parentError;
    liveParents = new Set((parents || []).map((row: { id: string }) => row.id));
  }
  return new Set(rows.filter((row) => !row.parent_task_id || liveParents.has(row.parent_task_id)).map((row) => row.id));
}

/** Entries with task_ids narrowed to live tasks (links to a task in Trash wait for its restore). */
export async function withLiveTaskIds<T extends { task_ids?: string[] }>(supabase: SupabaseClient, entries: T[]): Promise<T[]> {
  const live = await liveTaskIds(supabase, entries.flatMap((entry) => entry.task_ids ?? []));
  return entries.map((entry) => (entry.task_ids ? { ...entry, task_ids: entry.task_ids.filter((id) => live.has(id)) } : entry));
}

/**
 * Replaces an entry's task links with `taskIds`, keeping any link to a task in
 * Trash: the person editing cannot see it, and restoring the task brings the
 * link back.
 */
export async function replaceEntryTaskLinks(supabase: SupabaseClient, entryId: string, taskIds: string[]) {
  const { data: links, error } = await supabase.from('time_entry_tasks').select('task_id').eq('time_entry_id', entryId);
  if (error) throw error;
  const linked = (links || []).map((row: { task_id: string }) => row.task_id);
  const live = await liveTaskIds(supabase, linked);
  const kept = linked.filter((id) => !live.has(id));
  let removal = supabase.from('time_entry_tasks').delete().eq('time_entry_id', entryId);
  if (kept.length) removal = removal.not('task_id', 'in', `(${kept.join(',')})`);
  const { error: removeError } = await removal;
  if (removeError) throw removeError;
  const added = [...new Set(taskIds)].filter((id) => !kept.includes(id));
  if (added.length > 0) {
    const { error: linkError } = await supabase
      .from('time_entry_tasks')
      .insert(added.map((taskId) => ({ time_entry_id: entryId, task_id: taskId })));
    if (linkError) throw linkError;
  }
}

// Every task in the list must exist inside the given project. Used for time
// entry task links, where cross-project references would corrupt billing
// traceability.
export async function assertTasksInProject(
  supabase: SupabaseClient,
  taskIds: string[],
  projectId: string,
) {
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length === 0) return;
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('id, project_id')
    .in('id', uniqueIds)
    .is('deleted_at', null);
  if (error) throw error;
  const found = new Map((tasks || []).map((t: { id: string; project_id: string }) => [t.id, t.project_id]));
  for (const id of uniqueIds) {
    if (found.get(id) !== projectId) {
      throw badRequest('task_ids must reference existing tasks in this project');
    }
  }
}

// Everyone assigned must be able to open the task's project (on either
// channel: agents often hold project access on the API channel only).
// Assigning never grants access, so an assignee outside the project would be
// handed work they cannot see.
export async function assertAssigneesCanOpenProject(
  supabase: SupabaseClient,
  memberIds: string[],
  projectId: string,
) {
  for (const memberId of [...new Set(memberIds)]) {
    const access = await resolveMemberAccess(supabase, memberId);
    const canOpen = !!access
      && (accessAllowsProject(access, projectId, 'app') || accessAllowsProject(access, projectId, 'api'));
    if (!canOpen) {
      throw badRequest('assignee_ids must reference members who can open this project');
    }
  }
}

// A task's goal must be one of its own project's goals, or a scoped key could
// hang work off (and read progress into) a project it cannot see.
export async function assertGoalInProject(
  supabase: SupabaseClient,
  goalId: string,
  projectId: string,
) {
  const { data: goal, error } = await supabase
    .from('project_goals')
    .select('id, project_id')
    .eq('id', goalId)
    .maybeSingle();
  if (error) throw error;
  if (!goal || goal.project_id !== projectId) {
    throw badRequest('project_goal_id must reference a goal in the same project');
  }
}

// Blockers must belong to the same project as the task; anything else is
// rejected so cross-project task titles can never leak through dependencies.
export async function assertBlockersInProject(
  supabase: SupabaseClient,
  blockedByIds: string[],
  projectId: string,
  taskId?: string
) {
  const uniqueIds = [...new Set(blockedByIds)];
  if (taskId && uniqueIds.includes(taskId)) {
    throw badRequest('A task cannot be blocked by itself');
  }
  const { data: blockers, error } = await supabase
    .from('tasks')
    .select('id, project_id')
    .in('id', uniqueIds)
    .is('deleted_at', null);
  if (error) throw error;
  const found = new Map((blockers || []).map((b: { id: string; project_id: string }) => [b.id, b.project_id]));
  for (const id of uniqueIds) {
    if (found.get(id) !== projectId) {
      throw badRequest('blocked_by_ids must reference existing tasks in the same project');
    }
  }
}
