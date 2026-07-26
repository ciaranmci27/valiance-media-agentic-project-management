import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runDispatch } from '@/lib/webhooks/dispatch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Delivers pending webhook events. Called by the in-app kick after an invoice
// change, and by the "send" action in Settings > Webhooks. Authorized by a
// signed-in user with webhooks.manage.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: allowed } = await supabase.rpc('has_permission', {
    p_permission_key: 'webhooks.manage',
    p_access_channel: 'app',
  });
  if (allowed !== true) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const summary = await runDispatch();
  return NextResponse.json({ success: true, ...summary });
}
