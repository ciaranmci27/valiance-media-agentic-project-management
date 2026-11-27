import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { acceptPlanItem, acceptPlanItemSchema } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

/** A person accepts the agent's proposal, optionally changing its project, task, title or date: applied as theirs. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const text = await request.text();
    const edits = text.trim() ? await readBody(new Request(request.url, { method: 'POST', body: text }), acceptPlanItemSchema) : {};
    return acceptPlanItem(ctx, id, edits);
  });
}
