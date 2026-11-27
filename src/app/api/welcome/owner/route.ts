import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { createFirstOwner, FirstOwnerError } from '@/lib/setup/first-owner';
import { missingServerSettings } from '@/lib/setup/checks';

/**
 * The setup wizard's first step, open without signing in: POST { name,
 * email, password } makes the workspace's Owner on a fresh install and
 * returns the email to sign in with. Once anyone is on the team it answers
 * 409 for good. A handful of tries per address per window.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 10;
const tries = new Map<string, { count: number; resetAt: number }>();

/** Per server instance only: a speed bump, not the lock (the database decides who is first). */
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
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true') {
    return NextResponse.json({ error: 'The demo workspace has no accounts to create.' }, { status: 409 });
  }
  if (limited(request)) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429, headers: { 'Retry-After': String(WINDOW_MS / 1000) } });
  }
  // Same rule as the page: nothing past "Connect your server" until the required settings are set.
  if (missingServerSettings(process.env).length) {
    return NextResponse.json({ error: 'Finish connecting your server first: a required setting is missing.' }, { status: 409 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  try {
    const data = await createFirstOwner(getServiceClient(), body ?? {});
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof FirstOwnerError) {
      return NextResponse.json({ error: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status });
    }
    console.error('[welcome] first owner failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
