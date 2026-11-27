import { z } from 'zod';
import { assertId, InboxError, inboxActor, inboxChannel, inboxReaches, loadTriageableThread, many, one, type InboxContext } from './inbox-service';
import { comms } from '@/lib/communications/db';
import { ApiError } from '@/lib/api/errors';
import { moveTask, planTaskMove, type LosingMember } from '@/lib/api/task-move';

/**
 * A person ties a thread to a task, or unties it (session routes). The
 * agent links tasks when it triages; people correct it or add what it
 * missed. A person's link defaults to "related": the email is about the
 * task and asks for no change. A task may be on any project the person can
 * open: linking files the thread on that project too, as theirs.
 */

export const linkTaskSchema = z.object({
  task_id: z.string().uuid(),
  relation: z.enum(['created', 'updated', 'related']).default('related'),
  // The email to link; the newest in the thread when left out.
  message_id: z.string().uuid().nullable().default(null),
}).strict();
export type LinkTaskRequest = z.infer<typeof linkTaskSchema>;

async function liveTask(ctx: InboxContext, taskId: string): Promise<{ id: string; project_id: string; title: string }> {
  const task = await one<{ id: string; project_id: string; title: string }>(ctx.service.from('tasks')
    .select('id, project_id, title, project:projects!inner(id)').eq('id', assertId(taskId, 'task_id')).is('deleted_at', null).is('project.deleted_at', null).maybeSingle());
  if (!task || !inboxReaches(ctx, task.project_id)) throw new InboxError(404, 'Task not found');
  return task;
}

export async function linkThreadTask(ctx: InboxContext, threadId: string, request: LinkTaskRequest): Promise<{ task_id: string; message_id: string; relation: string; project_set: boolean }> {
  const thread = await loadTriageableThread(ctx, threadId);
  const task = await liveTask(ctx, request.task_id);
  const messages = await many<{ id: string }>(comms(ctx.service).from('messages').select('id')
    .eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: false }).order('id', { ascending: false }));
  const messageId = request.message_id ? assertId(request.message_id, 'message_id') : messages[0]?.id;
  if (!messageId || !messages.some((message) => message.id === messageId)) throw new InboxError(404, 'Email not found in this thread');

  // project_set: the thread was not on the task's project until now.
  const before = await many<{ project_id: string }>(comms(ctx.service).from('conversation_projects')
    .select('project_id').eq('conversation_id', thread.id).eq('project_id', task.project_id));
  const { error } = await comms(ctx.service).rpc('link_message_task', {
    p_message_id: messageId, p_task_id: task.id, p_relation: request.relation, p_member_id: ctx.memberId, p_as_person: true,
  });
  if (error) throw error;
  return { task_id: task.id, message_id: messageId, relation: request.relation, project_set: before.length === 0 };
}

/** Every link between this thread's emails and the task goes, whoever made it. The task stays. */
export async function unlinkThreadTask(ctx: InboxContext, threadId: string, taskId: string): Promise<{ removed: number }> {
  const thread = await loadTriageableThread(ctx, threadId);
  const id = assertId(taskId, 'task_id');
  // Only a task the member can open; a link to one in another project is not theirs to cut.
  const task = await one<{ id: string; project_id: string }>(ctx.service.from('tasks').select('id, project_id').eq('id', id).is('deleted_at', null).maybeSingle());
  if (!task || !inboxReaches(ctx, task.project_id)) throw new InboxError(404, 'Task not found');
  const messages = await many<{ id: string }>(comms(ctx.service).from('messages').select('id').eq('thread_id', thread.id));
  if (messages.length === 0) return { removed: 0 };
  const { data, error } = await comms(ctx.service).from('task_links')
    .delete().eq('task_id', id).in('message_id', messages.map((message) => message.id)).select('id');
  if (error) throw error;
  return { removed: (data ?? []).length };
}

// ---------------------------------------------------------------------------
// A conversation moves to another project: the agent's tasks from it can follow
// ---------------------------------------------------------------------------

export const moveThreadTasksSchema = z.object({
  project_id: z.string().uuid(),
  // The tasks to move; every task the agent made from this conversation when left out.
  task_ids: z.array(z.string().uuid()).max(100).optional(),
  lost_access: z.enum(['refuse', 'unassign', 'add_to_project']).default('refuse'),
  // Check only: which tasks would move, and who would lose them.
  dry_run: z.boolean().default(false),
}).strict();
export type MoveThreadTasksRequest = z.infer<typeof moveThreadTasksSchema>;

export interface ThreadTaskToMove { task_id: string; title: string; project_id: string; project_name: string | null }

export type MoveThreadTasksResult =
  | { dry_run: true; project: { id: string; name: string }; tasks: (ThreadTaskToMove & { refused: string | null })[]; losing: LosingMember[]; can_unassign: boolean; can_add_members: boolean }
  | { dry_run: false; project: { id: string; name: string }; moved: { task_id: string; title: string }[]; failed: { task_id: string; title: string; reason: string }[] };

/**
 * The live, top-level tasks the agent made from this conversation, on any
 * project the member can open: a plan's new task (applied, or a suggestion a
 * person added) and the older triage's created links. Subtasks go with their
 * parent, so they are not listed on their own.
 */
export async function agentTasksOfThread(ctx: InboxContext, threadId: string): Promise<ThreadTaskToMove[]> {
  const messages = await many<{ id: string }>(comms(ctx.service).from('messages').select('id').eq('thread_id', threadId));
  const messageIds = messages.map((message) => message.id);
  if (messageIds.length === 0) return [];
  const [items, links] = await Promise.all([
    many<{ task_id: string | null }>(comms(ctx.service).from('plan_items').select('task_id')
      .eq('conversation_id', threadId).eq('mode', 'live').eq('type', 'create_task').in('state', ['done', 'accepted'])),
    many<{ task_id: string }>(comms(ctx.service).from('task_links').select('task_id')
      .in('message_id', messageIds).eq('relation', 'created').not('triage_id', 'is', null)),
  ]);
  const ids = [...new Set([...items.map((item) => item.task_id), ...links.map((link) => link.task_id)].filter((id): id is string => !!id))];
  if (ids.length === 0) return [];
  const tasks = await many<{ id: string; title: string; project_id: string; parent_task_id: string | null; project: { name: string } | null }>(ctx.service.from('tasks')
    .select('id, title, project_id, parent_task_id, project:projects!inner(name)').in('id', ids).is('deleted_at', null).is('project.deleted_at', null));
  return tasks
    .filter((task) => !task.parent_task_id && inboxReaches(ctx, task.project_id))
    .map((task) => ({ task_id: task.id, title: task.title, project_id: task.project_id, project_name: task.project?.name ?? null }));
}

/**
 * Moves the agent's tasks from this conversation to `project_id`, each by
 * the same rules as moving it from its own menu (task-move.ts). A dry run
 * lists them with who would lose them, so the person confirms once.
 */
export async function moveThreadTasks(ctx: InboxContext, threadId: string, request: MoveThreadTasksRequest): Promise<MoveThreadTasksResult> {
  const thread = await loadTriageableThread(ctx, threadId);
  const projectId = assertId(request.project_id, 'project_id');
  const project = await one<{ id: string; name: string }>(ctx.service.from('projects').select('id, name').eq('id', projectId).is('deleted_at', null).maybeSingle());
  if (!project || !inboxReaches(ctx, project.id)) throw new InboxError(404, 'Project not found');
  const candidates = (await agentTasksOfThread(ctx, thread.id)).filter((task) => task.project_id !== project.id);
  const wanted = request.task_ids ? new Set(request.task_ids.map((id) => id.toLowerCase())) : null;
  if (wanted && [...wanted].some((id) => !candidates.some((task) => task.task_id === id))) {
    throw new InboxError(404, 'A task is not one the agent made from this conversation, or it is already on that project');
  }
  const tasks = wanted ? candidates.filter((task) => wanted.has(task.task_id)) : candidates;
  const actor = { db: inboxActor(ctx), access: ctx.access, memberId: ctx.memberId, channel: inboxChannel(ctx), scopes: ctx.scopes };
  if (request.dry_run) {
    const losing = new Map<string, LosingMember>();
    let canUnassign = false;
    let canAddMembers = false;
    const listed: (ThreadTaskToMove & { refused: string | null })[] = [];
    for (const task of tasks) {
      try {
        const plan = await planTaskMove(actor, task.task_id, project.id);
        canUnassign = plan.can_unassign;
        canAddMembers = plan.can_add_members;
        for (const member of plan.losing) {
          const known = losing.get(member.id);
          losing.set(member.id, known ? { ...known, on: [...new Set([...known.on, ...member.on])].sort() } : member);
        }
        listed.push({ ...task, refused: null });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        listed.push({ ...task, refused: error.message });
      }
    }
    return { dry_run: true, project, tasks: listed, losing: [...losing.values()], can_unassign: canUnassign, can_add_members: canAddMembers };
  }
  const moved: { task_id: string; title: string }[] = [];
  const failed: { task_id: string; title: string; reason: string }[] = [];
  for (const task of tasks) {
    try {
      await moveTask(actor, task.task_id, project.id, request.lost_access);
      moved.push({ task_id: task.task_id, title: task.title });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      failed.push({ task_id: task.task_id, title: task.title, reason: error.message });
    }
  }
  return { dry_run: false, project, moved, failed };
}
