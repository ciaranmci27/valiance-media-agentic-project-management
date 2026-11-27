import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { dismissMeeting, meetingDismissUndoSchema, undoMeetingDismissal } from '@/lib/communications/meeting/suggestions';

export const dynamic = 'force-dynamic';

/** A meeting asked for no new work: its waiting suggestions are skipped, its messages handled, the dismissal recorded. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => dismissMeeting(ctx, id));
}

/** Undo: the suggestions and messages it changed go back as they were, and the mark clears. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => undoMeetingDismissal(ctx, id, await readBody(request, meetingDismissUndoSchema)));
}
