import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import type { TaskCreatedVia, TaskSource } from '@/lib/types';
import { accessAllowsProject } from '@/lib/api/access';
import { taskSourceEmails } from '@/lib/communications/inbox-service';

export class TaskSourceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Where a task came from, for its panel: how it was made, the member it was
 * made as, the API key by name (never its secret), the key's own note, and
 * the email it was created from when the reader can open that email. The
 * stamp itself is the database's (stamp_task_source); this only reads it.
 */
export async function taskSource(ctx: { service: SupabaseClient; access: AccessContext; memberId: string }, taskId: string): Promise<TaskSource> {
  const { data: task, error } = await ctx.service.from('tasks')
    .select('id, project_id, created_at, created_by, created_via, created_by_key_id, created_note')
    .eq('id', taskId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!task || !accessAllowsProject(ctx.access, task.project_id)) throw new TaskSourceError(404, 'Task not found');

  const [member, key, emails] = await Promise.all([
    task.created_by
      ? ctx.service.from('team_members').select('id, name, role').eq('id', task.created_by).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.created_by_key_id
      ? ctx.service.from('api_keys').select('name').eq('id', task.created_by_key_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    taskSourceEmails(ctx, task.id).catch(() => null),
  ]);
  if (member.error) throw member.error;
  if (key.error) throw key.error;

  const fromEmail = emails?.emails.find((email) => email.relation === 'created') ?? null;
  return {
    via: (task.created_via ?? 'unknown') as TaskCreatedVia,
    created_at: task.created_at,
    by: member.data ? { id: member.data.id, name: member.data.name, agent: member.data.role === 'agent' } : null,
    key: key.data ? { name: key.data.name } : null,
    note: task.created_note ?? null,
    email: fromEmail ? {
      message_id: fromEmail.message_id,
      thread_id: fromEmail.thread_id,
      subject: fromEmail.subject,
      from: fromEmail.from?.name || fromEmail.from?.address || null,
    } : null,
  };
}
