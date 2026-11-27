import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { restoreAgentWork, restoreAgentWorkSchema, undoAgentWork, undoAgentWorkSchema } from '@/lib/communications/agent-work';

export const dynamic = 'force-dynamic';

/** Undo all: everything the agent did with these emails (or the whole conversation) is taken back. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => undoAgentWork(ctx, id, await readBody(request, undoAgentWorkSchema)));
}

/** Restore all: what one Undo all took back, put back. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => restoreAgentWork(ctx, id, await readBody(request, restoreAgentWorkSchema)));
}
