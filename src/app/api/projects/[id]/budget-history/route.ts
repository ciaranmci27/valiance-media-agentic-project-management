import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProjectBudgetHistory } from '@/lib/project-budget-history';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const entries = await getProjectBudgetHistory(projectId, 50);
  return NextResponse.json({ entries });
}
