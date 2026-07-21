import { NextResponse } from 'next/server';
import { getProjectBudgetHistory } from '@/lib/project-budget-history';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;

  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!accessAllows(auth.data.access, 'billing.manage') || !accessAllowsProject(auth.data.access, projectId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const entries = await getProjectBudgetHistory(projectId, 50);
  return NextResponse.json({ entries });
}
