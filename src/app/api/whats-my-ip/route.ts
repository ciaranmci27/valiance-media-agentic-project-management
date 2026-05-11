import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getClientIp } from '@/lib/portal-analytics';

export const dynamic = 'force-dynamic';

/**
 * Echo the request's client IP back to the caller. Used by the Business Info
 * settings page's "Add my current IP" button so admins don't have to look up
 * their own IP elsewhere.
 *
 * Auth-gated to team members so this can't be abused as a public IP-echo
 * service.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const ip = getClientIp(request);
  return NextResponse.json({ ip: ip ?? null });
}
