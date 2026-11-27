import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { linkTaskSchema, linkThreadTask, unlinkThreadTask } from '@/lib/communications/inbox-links';

export const dynamic = 'force-dynamic';

/**
 * A person ties the conversation (its newest email, or message_id) to a task
 * on any project they can open, as theirs (relation related by default);
 * linking files the conversation on that project too. Agents link through
 * their triage plans instead. A person's own decision: their own key or
 * connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const result = await inboxApi(() => linkThreadTask(inboxContextOf(ctx), params.threadId, body));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/links`, entityType: 'email_thread', entityId: params.threadId, statusCode: 201 });
  return created(result);
}, { schema: linkTaskSchema, permission: 'inbound_email.triage' });

/** A person unties the conversation from a task (?task_id=): every link between its emails and the task goes. The task stays. */
export const DELETE = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, searchParams } = ctx;
  const taskId = searchParams.get('task_id');
  if (!taskId) throw badRequest('task_id is required');
  const result = await inboxApi(() => unlinkThreadTask(inboxContextOf(ctx), params.threadId, taskId));
  auditInboxDecision(ctx, { method: 'DELETE', endpoint: `/api/v1/inbox/threads/${params.threadId}/links`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { permission: 'inbound_email.triage' });
