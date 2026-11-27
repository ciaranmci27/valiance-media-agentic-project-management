import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { recordBudgetChange } from '@/lib/api/budget-change';
import type { BudgetType } from '@/lib/project-budget-history';

export const dynamic = 'force-dynamic';

// Accepts both the new (type-aware) shape and the legacy (value-only) shape.
// The client already updated the projects row before calling this endpoint,
// so the *old* snapshot has to be supplied by the caller; we can't recover
// it from the database after the fact.
const schema = z.object({
  oldType: z.enum(['hours', 'amount']).nullable().optional(),
  newType: z.enum(['hours', 'amount']).nullable().optional(),
  oldValue: z.number().nullable().optional(),
  newValue: z.number().nullable().optional(),
  // Legacy aliases preserved for older callers.
  oldBudget: z.number().nullable().optional(),
  newBudget: z.number().nullable().optional(),
});

function resolveValue(
  primary: number | null | undefined,
  legacy: number | null | undefined,
): number | null {
  if (primary !== undefined) return primary;
  if (legacy !== undefined) return legacy;
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;

  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!accessAllows(auth.data.access, 'billing.manage') || !accessAllowsProject(auth.data.access, projectId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed' }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const oldSnapshot = {
    type: (body.oldType ?? null) as BudgetType,
    value: resolveValue(body.oldValue, body.oldBudget),
  };
  const newSnapshot = {
    type: (body.newType ?? null) as BudgetType,
    value: resolveValue(body.newValue, body.newBudget),
  };

  // History, then the budget-email bookkeeping (lib/api/budget-change.ts):
  // inline, so the answer comes back once any pending communication row is
  // in the database (the UI refetches the log off it). Budget emails need
  // the Client portal and Contacts as well as Billing; with them off only
  // the history is kept.
  const newHistoryId = await recordBudgetChange({
    access: auth.data.access,
    projectId,
    oldSnapshot,
    newSnapshot,
    changedBy: auth.data.memberId,
  });

  return NextResponse.json({ queued: true, historyId: newHistoryId });
}
