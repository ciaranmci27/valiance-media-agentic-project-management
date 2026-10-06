import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { setThreadProject } from '@/lib/inbound-email/inbox-service';
import { setThreadProjectSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** A person sets or confirms the thread's project, and may remember the sender or domain. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => setThreadProject(ctx, id, await readBody(request, setThreadProjectSchema)));
}
