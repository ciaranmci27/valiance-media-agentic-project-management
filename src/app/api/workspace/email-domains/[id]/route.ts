import { inboxRoute } from '@/lib/communications/inbox-route';
import { removeOwnDomain } from '@/lib/communications/inbox-settings-service';

export const dynamic = 'force-dynamic';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    await removeOwnDomain(ctx, id);
    return { removed: true };
  });
}
