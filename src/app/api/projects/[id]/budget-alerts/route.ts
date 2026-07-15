import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';
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

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Same membership check as the sibling budget-change route
  const service = getServiceClient();
  const { data: member } = await service
    .from('team_members')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await evaluateBudgetAlerts(projectId);
  return NextResponse.json({ evaluated: true });
}
