import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { encodeGoogleIntent, GOOGLE_INTENT_COOKIE, googleIntentCookieOptions, type GoogleIntent } from '@/lib/api/google-intent';
import { assertAccountChange, signInMethodsOrDefault } from '@/lib/api/sign-in';
import { getServiceClient } from '@/lib/api/supabase-service';
import { FirstOwnerError, startFirstOwnerGoogle } from '@/lib/setup/first-owner';
import { missingServerSettings } from '@/lib/setup/checks';
import { allowsGoogle, GOOGLE_OFF } from '@/lib/sign-in';
import { InviteError, InviteExpiredError, peekInvite } from '@/lib/team/invite';
import { safeNextPath } from '@/lib/supabase/next-path';

export const dynamic = 'force-dynamic';

/**
 * Before the browser leaves for Google: says what the round trip is for,
 * checks what can be checked now, and keeps it in a short-lived httpOnly
 * cookie for /auth/callback (src/lib/api/google-intent.ts). Open without
 * signing in, except for linking. POST { intent, ... }:
 * - sign-in { next? }: only while the workspace allows Google.
 * - invite { token }: the same, and the invite link must still work.
 * - first-owner { name, setup_code? }: a fresh install's Owner, by the same
 *   setup code rule as the password path.
 * - link: the signed-in member adds Google to their own login.
 * Answers { data: { ok: true } }, or { error, field? } with a status.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 30;
const tries = new Map<string, { count: number; resetAt: number }>();

/** Per server instance only: a speed bump on the setup code and invite tokens, not the lock. */
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

const refuse = (status: number, error: string, field?: string) =>
  NextResponse.json({ error, ...(field ? { field } : {}) }, { status, headers: { 'Cache-Control': 'no-store' } });

async function googleAllowed(): Promise<boolean> {
  return allowsGoogle(await signInMethodsOrDefault(getServiceClient()));
}

export async function POST(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true') {
    return refuse(409, 'The demo workspace has no sign-in to change.');
  }
  if (limited(request)) return refuse(429, 'Too many tries. Wait a few minutes and try again.');
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  let intent: GoogleIntent;
  try {
    switch (body?.intent) {
      case 'sign-in':
        if (!(await googleAllowed())) return refuse(409, GOOGLE_OFF);
        intent = { kind: 'sign-in', next: safeNextPath(typeof body.next === 'string' ? body.next : null) };
        break;
      case 'invite': {
        if (!(await googleAllowed())) return refuse(409, GOOGLE_OFF);
        await peekInvite(getServiceClient(), body.token);
        intent = { kind: 'invite', token: String(body.token) };
        break;
      }
      case 'first-owner': {
        if (missingServerSettings(process.env).length) {
          return refuse(409, 'Finish connecting your server first: a required setting is missing.');
        }
        const claim = await startFirstOwnerGoogle(getServiceClient(), { name: body.name, setup_code: body.setup_code });
        intent = { kind: 'first-owner', name: claim.name, setupCode: claim.setupCode, startedAt: Date.now() };
        break;
      }
      case 'link': {
        const auth = await requireSessionAccess();
        if (auth.error) return auth.error;
        await assertAccountChange(auth.data.service, { memberId: auth.data.memberId, authUserId: auth.data.user.id }, 'link_google');
        intent = { kind: 'link' };
        break;
      }
      default:
        return refuse(422, 'intent is sign-in, invite, first-owner or link');
    }
  } catch (error) {
    if (error instanceof FirstOwnerError) return refuse(error.status, error.message, error.field);
    if (error instanceof InviteExpiredError) return refuse(410, error.message);
    if (error instanceof InviteError) return refuse(error.status, error.message);
    if (error instanceof ApiError) return refuse(error.statusCode, error.message);
    console.error('[auth] google start failed:', error);
    return refuse(500, 'Something went wrong. Try again.');
  }
  const response = NextResponse.json({ data: { ok: true } }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(GOOGLE_INTENT_COOKIE, encodeGoogleIntent(intent), googleIntentCookieOptions(new URL(request.url).protocol === 'https:'));
  return response;
}
