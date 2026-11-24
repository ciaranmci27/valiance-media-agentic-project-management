import type { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError, forbidden } from '@/lib/api/errors';
import { accessAllows } from '@/lib/api/access';
import { createTaskWithRules } from '@/lib/api/create-task';
import { createTaskSchema } from '@/lib/schemas';
import { loadTriageableMessage } from '@/lib/communications/agent-access';
import { comms } from '@/lib/communications/db';

export const dynamic = 'force-dynamic';

type CreateTaskRequest = z.infer<typeof createTaskSchema>;

/**
 * A task an email asks for, on a project in the email's scope (checked before
 * the task exists, so a refused project leaves nothing behind), linked to the
 * email as created and filed on its conversation in one go. The body is the
 * task API's. Needs tasks.create and inbound_email.triage. The agent's rules
 * apply as on POST /api/v1/tasks: with create policy approval it answers 202
 * with a task suggestion (needs_approval), linking nothing; the suggestion's
 * metadata keeps the email's message_id. With close policy review a done
 * task is created in review.
 */
export const POST = withApi<CreateTaskRequest, { id: string }>(async (ctx) => {
  const { supabase, params, body, teamMemberId, access, scopes } = ctx;
  if (!(scopes.includes('inbound_email.triage') && accessAllows(access, 'inbound_email.triage', 'api'))) {
    throw forbidden('API scope required: inbound_email.triage', { reason: 'missing_scope', required: ['inbound_email.triage'] });
  }
  const message = await loadTriageableMessage(supabase, teamMemberId, access, params.id);
  const { data: source, error: scopeError } = await comms(supabase).rpc('scope_source', { p_message_id: message.id, p_project_id: body.project_id });
  if (scopeError) throw scopeError;
  if (!source) {
    const { data: scope } = await comms(supabase).rpc('message_scope', { p_message_id: message.id });
    throw new ApiError(422, 'VALIDATION_ERROR', 'This email may not touch that project: create the task on a project in its scope, or flag the email as needs_human and ask which project.', {
      reason: 'project_out_of_scope',
      project_id: body.project_id,
      project_scope: scope ?? null,
    });
  }
  const { status, data: task } = await createTaskWithRules(ctx, `/api/v1/inbound-emails/${message.id}/tasks`, { message_id: message.id });
  if (status === 202) return success(task, 202);
  const { data: link, error: linkError } = await comms(supabase).rpc('link_message_task', {
    p_message_id: message.id, p_task_id: task.id, p_relation: 'created', p_member_id: teamMemberId,
  });
  if (linkError) throw linkError;
  return created({ ...task, email_link: { message_id: message.id, relation: 'created', ...(link as Record<string, unknown>) } });
}, { schema: createTaskSchema, permission: 'tasks.create' });
