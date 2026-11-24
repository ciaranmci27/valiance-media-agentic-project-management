import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { getActorClient } from '@/lib/api/supabase-service';
import { moveTask, planTaskMove } from '@/lib/api/task-move';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  project_id: z.string().uuid(),
  lost_access: z.enum(['refuse', 'unassign', 'add_to_project']).default('refuse'),
  // Check only: who would lose the task, and what the mover may do about it.
  dry_run: z.boolean().default(false),
});

/**
 * Moves a task, with its subtasks, to another project as the signed-in
 * member: the task menu, the panel, bulk and the agent's receipt in the
 * Inbox all come here. The same rules as the API's (task-move.ts). A dry run
 * answers the plan: who would lose the task and whether the member may take
 * them off or add them to the project.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Send project_id: the project to move it to' }, { status: 400 });
  const { access, memberId } = auth.data;
  const actor = { db: getActorClient(memberId, 'app'), access, memberId, channel: 'app' as const };
  try {
    const { project_id: projectId, lost_access: lostAccess, dry_run: dryRun } = parsed.data;
    const data = dryRun ? await planTaskMove(actor, id, projectId) : await moveTask(actor, id, projectId, lostAccess);
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message, details: error.details ?? null }, { status: error.statusCode });
    console.error('[tasks] move failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
