import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSessionAccess } from '@/lib/api/access';
import type { SessionUser } from '@/lib/supabase/session-user';

type AdminAuthResult =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | { error: null; supabase: SupabaseClient; user: SessionUser };

/**
 * Compatibility helper for SMTP routes. Access is determined by the effective
 * permission model, including Owner-controlled role defaults and overrides.
 */
export async function requireAdmin(): Promise<AdminAuthResult> {
  const auth = await requireSessionAccess({ permission: 'smtp.manage' });
  if (auth.error) return { error: auth.error };
  return { error: null, supabase: auth.data.client, user: auth.data.user };
}
