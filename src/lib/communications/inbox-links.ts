import { z } from 'zod';
import { accessAllowsProject } from '@/lib/api/access';
import { InboxError, assertCanTriage, assertId, loadReadableThread, many, one, type InboxContext } from './inbox-service';
import { comms } from '@/lib/communications/db';

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
  if (!task || !accessAllowsProject(ctx.access, task.project_id)) throw new InboxError(404, 'Task not found');
  return task;
}

export async function linkThreadTask(ctx: InboxContext, threadId: string, request: LinkTaskRequest): Promise<{ task_id: string; message_id: string; relation: string; project_set: boolean }> {
  assertCanTriage(ctx.access);
  const thread = await loadReadableThread(ctx, threadId);
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
  assertCanTriage(ctx.access);
  const thread = await loadReadableThread(ctx, threadId);
  const id = assertId(taskId, 'task_id');
  // Only a task the member can open; a link to one in another project is not theirs to cut.
  const task = await one<{ id: string; project_id: string }>(ctx.service.from('tasks').select('id, project_id').eq('id', id).is('deleted_at', null).maybeSingle());
  if (!task || !accessAllowsProject(ctx.access, task.project_id)) throw new InboxError(404, 'Task not found');
  const messages = await many<{ id: string }>(comms(ctx.service).from('messages').select('id').eq('thread_id', thread.id));
  if (messages.length === 0) return { removed: 0 };
  const { data, error } = await comms(ctx.service).from('task_links')
    .delete().eq('task_id', id).in('message_id', messages.map((message) => message.id)).select('id');
  if (error) throw error;
  return { removed: (data ?? []).length };
}
