import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';

type AdminAuthResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | { error: null; supabase: Awaited<ReturnType<typeof createClient>>; user: User };

/**
 * Verifies the caller has a session AND holds the admin role in team_members.
 * Returns the session-scoped supabase client on success, or a ready-to-return
 * 401/403 response on failure.
 */
export async function requireAdmin(): Promise<AdminAuthResult> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const service = getServiceClient();
  const { data: member } = await service
    .from('team_members')
    .select('role')
    .eq('auth_user_id', user.id)
    .single();

  if (!member || member.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden – admin role required' }, { status: 403 }) };
  }

  return { error: null, supabase, user };
}
