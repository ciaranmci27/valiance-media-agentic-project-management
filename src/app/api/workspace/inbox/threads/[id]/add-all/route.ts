import { inboxRoute } from '@/lib/communications/inbox-route';
import { addAllSuggestions } from '@/lib/communications/meeting/suggestions';

export const dynamic = 'force-dynamic';

/** Every waiting suggestion of a meeting, added as the person's through the usual accept. Undo is per item, newest first. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => addAllSuggestions(ctx, id));
}
