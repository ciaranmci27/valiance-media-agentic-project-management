import { NextRequest, NextResponse } from 'next/server';
import { accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { evaluateBudgetAlerts } from '@/lib/email/client-notifications';

export const dynamic = 'force-dynamic';

// Re-evaluates budget alert thresholds for a project. Called by the dashboard
// after time-entry mutations; the v1 API routes call evaluateBudgetAlerts
// directly. evaluateBudgetAlerts swallows its own errors, so this endpoint
// only fails on auth.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;

  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!accessAllowsProject(auth.data.access, projectId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  await evaluateBudgetAlerts(projectId);
  return NextResponse.json({ evaluated: true });
}
