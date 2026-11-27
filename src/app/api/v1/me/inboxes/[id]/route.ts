import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertPersonCaller } from '@/lib/api/people-only';
import { assertInboxOn, auditInboxSetup, inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { removeMyInbox, updateMyInbox } from '@/lib/communications/inbox-settings-service';
import { myInboxSchema, type MyInboxRequest } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/** Change one of your own inboxes: its address, its agent, who else reads it, on or off. People only. */
export const PUT = withApi<MyInboxRequest, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  const inbox = await inboxApi(() => updateMyInbox(inboxContextOf(ctx), ctx.params.id, ctx.body));
  auditInboxSetup(ctx, { method: 'PUT', endpoint: `/api/v1/me/inboxes/${ctx.params.id}`, entityType: 'inbox', entityId: ctx.params.id });
  return success(inbox);
}, { schema: myInboxSchema, permission: 'tasks.read' });

/** Remove one of your own inboxes, only while it holds no mail (409: turn it off instead). People only. */
export const DELETE = withApi<unknown, Params>(async (ctx) => {
  assertPersonCaller(ctx.access);
  assertInboxOn(ctx.access);
  await inboxApi(() => removeMyInbox(inboxContextOf(ctx), ctx.params.id));
  auditInboxSetup(ctx, { method: 'DELETE', endpoint: `/api/v1/me/inboxes/${ctx.params.id}`, entityType: 'inbox', entityId: ctx.params.id });
  return success({ removed: true });
}, { permission: 'tasks.read' });
