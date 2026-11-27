import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxApi, inboxContextOf } from '@/lib/api/inbox-api';
import { draftWriter, latestDraft } from '@/lib/communications/inbox-drafts';
import { threadDetail } from '@/lib/communications/inbox-service';

export const dynamic = 'force-dynamic';

/**
 * One conversation, as the Inbox shows it: oldest email first, each with its
 * triage, attachments and linked tasks, the projects it is filed on, its
 * plans, can_triage (whether the key's member may act on it) and its newest
 * reply draft. A conversation in an inbox the key cannot read is 404.
 */
export const GET = withApi(async (ctx) => {
  const inbox = inboxContextOf(ctx);
  return success(await inboxApi(async () => {
    const detail = await threadDetail(inbox, ctx.params.threadId);
    const [replyDraft, writer] = await Promise.all([latestDraft(inbox, detail.id), draftWriter(inbox.service, inbox.access, detail.inbox.id)]);
    return { ...detail, reply_draft: replyDraft, reply_drafter: writer.writer };
  }));
}, { permission: 'inbound_email.read' });
