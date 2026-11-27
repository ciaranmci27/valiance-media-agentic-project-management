import { inboxRoute } from '@/lib/communications/inbox-route';
import { draftWriter, latestDraft } from '@/lib/communications/inbox-drafts';
import { threadDetail } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/** One thread, oldest message first, with triage, attachments, linked tasks and its newest reply draft. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const detail = await threadDetail(ctx, id);
    const [replyDraft, writer] = await Promise.all([latestDraft(ctx, detail.id), draftWriter(ctx.service, ctx.access, detail.inbox.id)]);
    return { ...detail, reply_draft: replyDraft, reply_drafter: writer.writer };
  });
}
