import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { createMyInbox, listMyInboxes } from '@/lib/communications/inbox-settings-service';
import { myInboxSchema, type MyInboxRequest } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/**
 * Settings > Email > Your inbox: your own personal inboxes. A person's own
 * key or connected AI tool, never an agent (403 people_only), and the person
 * must be allowed to connect their own inbox (inbound_email.personal), as in
 * the app. Any member's key reaches it (tasks.read); the rest is checked here.
 */
export const GET = withApi(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  return success(await inboxApi(() => listMyInboxes(inboxContextOf(ctx))));
}, { permission: 'tasks.read' });

/** Connect one: your address, the agent that sorts it (one of yours, or nobody) and who else reads it. */
export const POST = withApi<MyInboxRequest>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  const inbox = await inboxApi(() => createMyInbox(inboxContextOf(ctx), ctx.body));
  auditInboxSetup(ctx, { method: 'POST', endpoint: '/api/v1/me/inboxes', entityType: 'inbox', entityId: inbox.id, statusCode: 201 });
  return created(inbox);
}, { schema: myInboxSchema, permission: 'tasks.read' });
