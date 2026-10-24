import { z } from 'zod';
import { accessAllowsProject } from '@/lib/api/access';
import { InboxError, assertCanTriage, assertId, loadReadableThread, many, one, type InboxContext } from './inbox-service';

/**
 * A person ties a thread to a task, or unties it (session routes). The
 * agent links tasks when it triages; people correct it or add what it
 * missed. A person's link defaults to "related": the email is about the
 * task and asks for no change. Linking a task to a thread without a project
 * files the thread in the task's project; a task in another project than
 * the thread's is refused.
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
  if (thread.project_id && thread.project_id !== task.project_id) {
    throw new InboxError(422, `"${task.title}" is in another project than this thread. Change the thread's project first.`);
  }
  const messages = await many<{ id: string }>(ctx.service.from('email_messages').select('id')
    .eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: false }).order('id', { ascending: false }));
  const messageId = request.message_id ? assertId(request.message_id, 'message_id') : messages[0]?.id;
  if (!messageId || !messages.some((message) => message.id === messageId)) throw new InboxError(404, 'Email not found in this thread');

  let projectSet = false;
  if (!thread.project_id) {
    const { data, error } = await ctx.service.from('email_threads')
      .update({ project_id: task.project_id, project_source: 'person', project_address_id: null })
      .eq('id', thread.id).is('project_id', null).select('id');
    if (error) throw error;
    projectSet = (data ?? []).length > 0;
  }
  const { error } = await ctx.service.from('email_task_links').upsert(
    { message_id: messageId, task_id: task.id, relation: request.relation, triage_id: null, linked_by: ctx.memberId },
    { onConflict: 'message_id,task_id,relation', ignoreDuplicates: true },
  );
  if (error) throw error;
  return { task_id: task.id, message_id: messageId, relation: request.relation, project_set: projectSet };
}

/** Every link between this thread's emails and the task goes, whoever made it. The task stays. */
export async function unlinkThreadTask(ctx: InboxContext, threadId: string, taskId: string): Promise<{ removed: number }> {
  assertCanTriage(ctx.access);
  const thread = await loadReadableThread(ctx, threadId);
  const id = assertId(taskId, 'task_id');
  const messages = await many<{ id: string }>(ctx.service.from('email_messages').select('id').eq('thread_id', thread.id));
  if (messages.length === 0) return { removed: 0 };
  const { data, error } = await ctx.service.from('email_task_links')
    .delete().eq('task_id', id).in('message_id', messages.map((message) => message.id)).select('id');
  if (error) throw error;
  return { removed: (data ?? []).length };
}
