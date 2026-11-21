import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { removeMyInbox, updateMyInbox } from '@/lib/communications/inbox-settings-service';
import { myInboxSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Change one of your own inboxes: its address, its agent, who else reads it, on or off. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => updateMyInbox(ctx, id, await readBody(request, myInboxSchema)));
}

/** Remove one of your own inboxes, only while it holds no mail. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    await removeMyInbox(ctx, id);
    return { removed: true };
  });
}
