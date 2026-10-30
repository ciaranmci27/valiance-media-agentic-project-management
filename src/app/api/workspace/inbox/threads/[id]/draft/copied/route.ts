import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { draftCopiedSchema, markDraftCopied } from '@/lib/communications/inbox-drafts';

export const dynamic = 'force-dynamic';

/** A person copied the thread's reply draft into their own mail. Nothing is sent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const { draft_id } = await readBody(request, draftCopiedSchema);
    return markDraftCopied(ctx, id, draft_id);
  });
}
