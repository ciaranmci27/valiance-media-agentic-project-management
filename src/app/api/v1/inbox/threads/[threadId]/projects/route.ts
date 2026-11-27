import { withApi } from '@/lib/api/middleware';
import { created } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { auditInboxDecision, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { setThreadProject } from '@/lib/communications/inbox-service';
import { setThreadProjectSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * A person files the conversation on a project beside its others (or confirms one the agent guessed), as
 * theirs, and may remember the sender or domain for it. Agents file through their triage plans instead.
 * The thread is threadId, not id: withApi reads params.id under a /projects/ path as a project.
 * A person's own decision: their own key or connected AI tool; agents, company or personal, are refused (403 people_only).
 */
export const POST = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  const { params, body } = ctx;
  const inbox = inboxContextOf(ctx);
  const result = await inboxApi(() => setThreadProject(inbox, params.threadId, body));
  auditInboxDecision(ctx, { method: 'POST', endpoint: `/api/v1/inbox/threads/${params.threadId}/projects`, entityType: 'email_thread', entityId: params.threadId, statusCode: 201 });
  return created(result);
}, { schema: setThreadProjectSchema, permission: 'inbound_email.triage' });
