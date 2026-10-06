import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { removeClientSender } from '@/lib/inbound-email/inbox-settings-service';

export const dynamic = 'force-dynamic';

/** A person removes a client email address (agents never delete mappings). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; senderId: string }> }) {
  const { id, senderId } = await params;
  return inboxRoute(async (ctx) => {
    await removeClientSender(ctx, id, senderId);
    return { removed: true };
  });
}
