import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { accessAllowsProject } from '@/lib/api/access';
import { ApiError, badRequest, forbidden, notFound } from '@/lib/api/errors';
import { assertAssigneesCanOpenProject } from '@/lib/api/task-guards';

/**
 * A subtask as a task's readers see it: enough to list and work it. task_id
 * (its parent) and completed keep what text subtasks answered, so a reader
 * of the old shape keeps working.
 */
export interface SubtaskSummary {
  id: string;
  task_id: string;
  title: string;
  status: string;
  completed: boolean;
  assignee_ids: string[];
  due_date: string | null;
  sort_order: number;
}

type ChildRow = {
  id: string;
  parent_task_id: string;
  title: string;
  status: string;
  due_date: string | null;
  sort_order: number;
  task_assignees: { member_id: string }[] | null;
};

/** The live subtasks of each parent, in their order. */
export async function subtaskSummaries(supabase: SupabaseClient, parentIds: string[]): Promise<Map<string, SubtaskSummary[]>> {
  const byParent = new Map<string, SubtaskSummary[]>();
  const unique = [...new Set(parentIds)];
  if (unique.length === 0) return byParent;
  const { data, error } = await supabase
    .from('tasks')
    .select('id, parent_task_id, title, status, due_date, sort_order, task_assignees(member_id)')
    .in('parent_task_id', unique)
    .is('deleted_at', null)
    .order('sort_order')
    .order('created_at');
  if (error) throw error;
  for (const row of (data || []) as ChildRow[]) {
    const list = byParent.get(row.parent_task_id) ?? [];
    list.push({
      id: row.id,
      task_id: row.parent_task_id,
      title: row.title,
      status: row.status,
      completed: row.status === 'done',
      assignee_ids: (row.task_assignees || []).map((a) => a.member_id),
      due_date: row.due_date,
      sort_order: row.sort_order,
    });
    byParent.set(row.parent_task_id, list);
  }
  return byParent;
}

/** Where the next subtask of a parent goes: after its last live one. */
export async function nextSubtaskOrder(supabase: SupabaseClient, parentId: string): Promise<number> {
  const { data, error } = await supabase
    .from('tasks')
    .select('sort_order')
    .eq('parent_task_id', parentId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? (data[0] as { sort_order: number }).sort_order + 1 : 0;
}

export interface ParentTask {
  id: string;
  title: string;
  project_id: string;
  parent_task_id: string | null;
  assignee_ids: string[];
}

/**
 * The task named as a parent, as the caller may use it: live (it, its
 * project), top-level, and in a project they can open on `channel`. Server
 * routes run as the service role, so this is where a key's reach is checked.
 */
export async function loadParentTask(
  supabase: SupabaseClient,
  parentId: string,
  access: AccessContext,
  channel: 'api' | 'app' = 'api',
): Promise<ParentTask> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, project_id, parent_task_id, task_assignees(member_id), project:projects!inner(id)')
    .eq('id', parentId)
    .is('deleted_at', null)
    .is('project.deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Parent task');
  if (!accessAllowsProject(access, data.project_id, channel)) throw notFound('Parent task');
  if (data.parent_task_id) {
    throw badRequest(`Subtasks go one level deep: "${data.title}" is itself a subtask.`);
  }
  return {
    id: data.id,
    title: data.title,
    project_id: data.project_id,
    parent_task_id: data.parent_task_id,
    assignee_ids: ((data.task_assignees || []) as { member_id: string }[]).map((a) => a.member_id),
  };
}

/** Whoever adds to or moves work under a parent must be able to manage it: all tasks, or be on it. */
export function assertCanManageParent(parent: ParentTask, memberId: string, canManageAll: boolean) {
  if (!canManageAll && !parent.assignee_ids.includes(memberId)) {
    throw forbidden(`You can only add subtasks to tasks you are assigned to, unless you may manage all tasks ("${parent.title}" is not yours)`);
  }
}

/** A database refusal from the subtask rules, as the API reports it. */
export function subtaskRuleError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (!message) return error;
  if (code === 'P0002') return notFound('Task');
  if (code === '23514' || code === '55000') return badRequest(message);
  if (code === '42501') return forbidden(message);
  return error;
}

interface SetParentActor {
  supabase: SupabaseClient;
  memberId: string;
  access: AccessContext;
  /** May manage every task (and so move work between projects). */
  canManageAll: boolean;
  channel?: 'api' | 'app';
}

/**
 * Nests a task under `parentId` or makes it top-level (null), through
 * set_task_parent, which holds the rules (one level, the parent's project,
 * blocker links stay inside one project). The caller has already checked
 * they may manage the task itself. Under a parent in another project it
 * moves there: that needs manage-all, the project, and assignees who can open it.
 */
export async function setTaskParentAs(
  { supabase, memberId, access, canManageAll, channel = 'api' }: SetParentActor,
  task: { id: string; project_id: string; parent_task_id: string | null },
  parentId: string | null,
) {
  if (parentId === null && !canManageAll) {
    // Working a subtask through its parent ends when it leaves the parent, so
    // promoting it takes being on the subtask itself, as in the app.
    const { data: own, error } = await supabase
      .from('task_assignees').select('member_id').eq('task_id', task.id).eq('member_id', memberId).maybeSingle();
    if (error) throw error;
    if (!own) throw forbidden('Only someone assigned to this subtask, or who may manage all tasks, can make it top-level');
  }
  if (parentId !== null) {
    if (parentId === task.id) throw badRequest('A task cannot be its own subtask.');
    const parent = await loadParentTask(supabase, parentId, access, channel);
    assertCanManageParent(parent, memberId, canManageAll);
    if (parent.project_id !== task.project_id) {
      if (!canManageAll) {
        throw forbidden('Moving a task to another project requires the tasks.manage_all permission');
      }
      const { data: assignees, error } = await supabase.from('task_assignees').select('member_id').eq('task_id', task.id);
      if (error) throw error;
      const ids = (assignees || []).map((a: { member_id: string }) => a.member_id);
      if (ids.length > 0) await assertAssigneesCanOpenProject(supabase, ids, parent.project_id);
    }
  }
  const { data, error } = await supabase.rpc('set_task_parent', { p_task_id: task.id, p_parent_id: parentId });
  if (error) throw subtaskRuleError(error);
  return data as Record<string, unknown>;
}
