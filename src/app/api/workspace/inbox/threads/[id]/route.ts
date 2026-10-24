import { inboxRoute } from '@/lib/inbound-email/inbox-route';
import { latestDraft } from '@/lib/inbound-email/inbox-drafts';
import { threadDetail } from '@/lib/inbound-email/inbox-service';

export const dynamic = 'force-dynamic';

/** One thread, oldest message first, with triage, attachments, linked tasks and its newest reply draft. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const detail = await threadDetail(ctx, id);
    return { ...detail, reply_draft: await latestDraft(ctx, detail.id) };
  });
}
