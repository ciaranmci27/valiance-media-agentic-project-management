import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { setThreadProject } from '@/lib/communications/inbox-service';
import { setThreadProjectSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** A person adds or confirms a project on the thread, and may remember the sender or domain (the older path of POST .../projects). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => setThreadProject(ctx, id, await readBody(request, setThreadProjectSchema)));
}
