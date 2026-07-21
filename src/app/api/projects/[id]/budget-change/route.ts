import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { handleBudgetChange } from '@/lib/email/client-notifications';
import { logProjectBudgetChange, type BudgetType } from '@/lib/project-budget-history';

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

  // 1. Log history first so the era id is available to the notification layer.
  //    `logProjectBudgetChange` returns null on identical snapshots or errors.
  const newHistoryId = await logProjectBudgetChange({
    projectId,
    oldSnapshot,
    newSnapshot,
    changedBy: auth.data.memberId,
  }).catch(() => null);

  // 2. Run notification orchestration inline so the response only comes back
  //    once any pending communication row is in the database. The UI refetches
  //    the communication log off the back of this response, so deferring to
  //    after() would show a stale log until the next refresh. Latency cost is
  //    one render + one insert (~200-500ms), acceptable for a form submit.
  //    Errors are swallowed so a misconfigured project can't block the budget
  //    history write that already succeeded above.
  await handleBudgetChange(
    projectId,
    oldSnapshot.type,
    oldSnapshot.value,
    newSnapshot.type,
    newSnapshot.value,
    auth.data.memberId,
    newHistoryId,
  ).catch(() => {});

  return NextResponse.json({ queued: true, historyId: newHistoryId });
}
