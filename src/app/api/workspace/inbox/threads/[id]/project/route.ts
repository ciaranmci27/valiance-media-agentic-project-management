import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { setThreadProject } from '@/lib/communications/inbox-service';
import { setThreadProjectSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** A person sets or confirms the thread's project, and may remember the sender or domain. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => setThreadProject(ctx, id, await readBody(request, setThreadProjectSchema)));
}
