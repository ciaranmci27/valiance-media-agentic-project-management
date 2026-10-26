import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { sendBackToAgent } from '@/lib/communications/inbox-service';
import { sendBackSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** The message (the newest by default) goes back to New so the agent triages it again. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const body = await readBody(request, sendBackSchema);
    return sendBackToAgent(ctx, id, body.message_id ?? null);
  });
}
