import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeThreadProject } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/**
 * A person takes a project off the conversation; refused (409) while one of
 * its emails is linked to a task on that project. The thread is threadId,
 * not id: withApi reads params.id under a /projects/ path as a project.
 * A person's own decision: their own key or connected AI tool; agents,
 * company or personal, are refused (403 people_only).
 */
export const DELETE = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params } = ctx;
  const result = await inboxApi(() => removeThreadProject(inboxContextOf(ctx), params.threadId, params.projectId));
  auditInboxDecision(ctx, { method: 'DELETE', endpoint: `/api/v1/inbox/threads/${params.threadId}/projects/${params.projectId}`, entityType: 'email_thread', entityId: params.threadId });
  return success(result);
}, { permission: 'inbound_email.triage' });
