import { z } from 'zod';
import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { acceptPlanItem } from '@/lib/communications/inbox-plans';

export const dynamic = 'force-dynamic';

const acceptSchema = z.object({
  project_id: z.uuid().optional(),
  task_id: z.uuid().optional(),
  title: z.string().trim().min(1).max(500).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();

/** A person accepts the agent's proposal, optionally changing its project, task, title or date: applied as theirs. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const text = await request.text();
    const edits = text.trim() ? await readBody(new Request(request.url, { method: 'POST', body: text }), acceptSchema) : {};
    return acceptPlanItem(ctx, id, edits);
  });
}
