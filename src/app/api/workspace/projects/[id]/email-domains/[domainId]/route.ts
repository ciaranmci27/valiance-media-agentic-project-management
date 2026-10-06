import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { removeClientDomain } from '@/lib/inbound-email/inbox-settings-service';

export const dynamic = 'force-dynamic';

/** A person removes a client domain mapping (agents never delete mappings). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; domainId: string }> }) {
  const { id, domainId } = await params;
  return inboxRoute(async (ctx) => {
    await removeClientDomain(ctx, id, domainId);
    return { removed: true };
  });
}
