import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { threadDetail } from '@/lib/inbound-email/inbox-service';

export const dynamic = 'force-dynamic';

/** One thread, oldest message first, with triage, attachments and linked tasks. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => threadDetail(ctx, id));
}
