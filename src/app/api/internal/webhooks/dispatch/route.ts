import { NextResponse } from 'next/server';
import { runDispatch } from '@/lib/webhooks/dispatch';
import { moduleOffResponse, requireSessionAccess } from '@/lib/api/access';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Delivers pending webhook events. Called by the in-app kick after a change
// (a task, comment, suggestion or invoice saved in the browser), and by the
// "send" action in Settings > Webhooks. Any active member may nudge it while
// Webhooks is on: it takes no input and only sends what the database already
// queued. The run's counts go only to members with webhooks.manage.
export async function POST() {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access } = auth.data;
  if (!isModuleEnabled(access, 'webhooks')) return moduleOffResponse('webhooks');

  const summary = await runDispatch();
  if (!hasPermission(access, 'webhooks.manage')) return NextResponse.json({ success: true });
  return NextResponse.json({ success: true, ...summary });
}
