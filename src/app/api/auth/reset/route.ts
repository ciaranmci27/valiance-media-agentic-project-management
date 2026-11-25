import { NextRequest, NextResponse } from 'next/server';
import { afterResponse } from '@/lib/api/after-response';
import { sendPasswordReset } from '@/lib/api/password-reset';
import { getServiceClient } from '@/lib/api/supabase-service';
import { RESET_SENT } from '@/lib/sign-in';
import { appUrlFor } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

/**
 * Forgot password, open without signing in. POST { email } always answers
 * { data: { message: RESET_SENT } }: the lookup and the email happen after
 * the response (src/lib/api/password-reset.ts), so nothing here says
 * whether an account exists. A handful of tries per address per window.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 10;
const tries = new Map<string, { count: number; resetAt: number }>();

/** Per server instance only: a speed bump (Supabase limits its own reset emails too). */
function limited(request: NextRequest): boolean {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  if (tries.size > 5000) for (const [key, entry] of tries) if (entry.resetAt <= now) tries.delete(key);
  const entry = tries.get(ip);
  if (!entry || entry.resetAt <= now) {
    tries.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_TRIES;
}

export async function POST(request: NextRequest) {
  if (limited(request)) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 });
  }
  const body = await request.json().catch(() => null) as { email?: unknown } | null;
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true';
  if (!demo) {
    const appUrl = appUrlFor(new URL(request.url).origin);
    afterResponse('password reset', () => sendPasswordReset(getServiceClient(), { email: body?.email, appUrl }));
  }
  return NextResponse.json({ data: { message: RESET_SENT } }, { headers: { 'Cache-Control': 'no-store' } });
}
