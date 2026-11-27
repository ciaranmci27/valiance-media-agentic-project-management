import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { InviteError, InviteExpiredError, peekInvite, redeemInvite } from '@/lib/team/invite';
import { googleProviderState, signInMethodsOrDefault } from '@/lib/api/sign-in';
import { allowsGoogle, signInChoices } from '@/lib/sign-in';

/**
 * The invite link's server side, open without signing in.
 * - GET ?token=: who the link is for (their name), to greet them, and the ways
 *   they may join (password, google: the workspace's sign-in methods). Spends
 *   nothing, so a mail scanner opening the link changes nothing.
 * - POST { token, password }: sets the password once and returns the email to
 *   sign in with.
 * Expired, used and unknown links all answer 410 "This link has expired".
 * Tokens are 32 random bytes; on top of that, each address gets a handful of
 * tries per window.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 20;
const MIN_PASSWORD = 8;
const tries = new Map<string, { count: number; resetAt: number }>();

/** Per server instance only; with 2^256 possible tokens this is a speed bump, not the lock. */
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

function answer(error: unknown) {
  if (error instanceof InviteExpiredError) return NextResponse.json({ error: error.message, code: 'INVITE_EXPIRED' }, { status: 410 });
  if (error instanceof InviteError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error('[welcome] set-password failed:', error);
  return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
}

const tooMany = () => NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429, headers: { 'Retry-After': String(WINDOW_MS / 1000) } });

export async function GET(request: NextRequest) {
  if (limited(request)) return tooMany();
  try {
    const service = getServiceClient();
    const invite = await peekInvite(service, request.nextUrl.searchParams.get('token'));
    const methods = await signInMethodsOrDefault(service);
    const choices = signInChoices(methods, allowsGoogle(methods) ? await googleProviderState() : 'unknown');
    return NextResponse.json({ data: { ...invite, ...choices } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return answer(error);
  }
}

export async function POST(request: NextRequest) {
  if (limited(request)) return tooMany();
  const body = await request.json().catch(() => null) as { token?: unknown; password?: unknown } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json({ error: `Use at least ${MIN_PASSWORD} characters.`, field: 'password' }, { status: 422 });
  }
  if (password.length > 72) {
    return NextResponse.json({ error: 'Use at most 72 characters.', field: 'password' }, { status: 422 });
  }
  try {
    const data = await redeemInvite(getServiceClient(), { token: body?.token, password });
    return NextResponse.json({ data });
  } catch (error) {
    return answer(error);
  }
}
