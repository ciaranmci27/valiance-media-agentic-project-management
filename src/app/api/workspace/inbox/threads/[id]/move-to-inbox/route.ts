import { z } from 'zod';
import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { moveToInbox } from '@/lib/communications/inbox-rules';

export const dynamic = 'force-dynamic';

const moveToInboxSchema = z.object({ message_id: z.string().uuid() }).strict();

/** A filtered pitch back to the Inbox: the agent reads it in full, and its sender always from now on. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const body = await readBody(request, moveToInboxSchema);
    return moveToInbox(ctx, id, body.message_id);
  });
}
