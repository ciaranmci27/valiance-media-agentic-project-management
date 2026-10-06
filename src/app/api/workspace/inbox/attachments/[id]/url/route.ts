import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { attachmentDownloadUrl } from '@/lib/inbound-email/inbox-service';

export const dynamic = 'force-dynamic';

/** A one-minute signed download link for a stored attachment. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => attachmentDownloadUrl(ctx, id));
}
