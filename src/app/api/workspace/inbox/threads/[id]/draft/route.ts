import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { requestDraftSchema, requestReplyDraft } from '@/lib/communications/inbox-drafts';

export const dynamic = 'force-dynamic';

/** Ask the agent to draft a reply to the thread's newest email. Nothing is sent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => requestReplyDraft(ctx, id, await readBody(request, requestDraftSchema)), 201);
}
