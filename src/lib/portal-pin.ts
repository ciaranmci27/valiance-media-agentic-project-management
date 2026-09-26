/**
 * The one PIN check every portal route runs. A 4-digit PIN is only 10,000
 * guesses, so wrong attempts are rate limited from the pin_attempt rows the
 * analytics table already keeps.
 *
 * Two layers. A visitor (IP) who misses too often is locked out for a while,
 * which is the friendly limit a client mistyping will ever meet. The portal
 * itself also has hourly and daily ceilings that lock everyone out, because
 * the client IP comes from a forwarding header that some hosts let the caller
 * write: rotating it must not buy an attacker unlimited guesses. At the daily
 * ceiling a 4-digit PIN takes weeks to brute force, and every miss is visible
 * in the portal's analytics.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getClientIp, getOrCreateSessionId, recordPortalEvent, stripCidrHostPrefix } from '@/lib/portal-analytics';

/** Misses one visitor (IP) may make inside the window before a lockout. */
export const PIN_MAX_MISSES_PER_VISITOR = 5;
export const PIN_VISITOR_WINDOW_MS = 15 * 60_000;
/** Misses across every visitor that lock the whole portal. */
export const PIN_MAX_MISSES_PER_PORTAL_HOUR = 20;
export const PIN_MAX_MISSES_PER_PORTAL_DAY = 100;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export interface PinAttempt {
  ip: string | null;
  at: number;
}

/**
 * Seconds until fewer than `max` of `times` fall inside the window, or 0 when
 * they already do. The lock lifts when the max-th newest miss ages out.
 */
function secondsUntilUnder(times: number[], max: number, windowMs: number, now: number): number {
  const recent = times.filter(at => now - at < windowMs).sort((a, b) => b - a);
  if (recent.length < max) return 0;
  return Math.max(1, Math.ceil((recent[max - 1] + windowMs - now) / 1000));
}

/**
 * Pure lockout decision over recent misses for one portal. Returns the
 * seconds until the visitor may try again, or 0 when they are not locked.
 */
export function pinLockoutSeconds(misses: PinAttempt[], visitorIp: string | null, now: number): number {
  const all = misses.map(m => m.at);
  const mine = misses.filter(m => m.ip === visitorIp).map(m => m.at);
  return Math.max(
    secondsUntilUnder(mine, PIN_MAX_MISSES_PER_VISITOR, PIN_VISITOR_WINDOW_MS, now),
    secondsUntilUnder(all, PIN_MAX_MISSES_PER_PORTAL_HOUR, HOUR_MS, now),
    secondsUntilUnder(all, PIN_MAX_MISSES_PER_PORTAL_DAY, DAY_MS, now),
  );
}

function pinsMatch(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type PortalPinResult =
  | { ok: true }
  | { ok: false; reason: 'required' | 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number };

interface PinSettings {
  id: string;
  project_id: string;
  pin: string | null;
}

export async function checkPortalPin({
  supabase,
  request,
  token,
  settings,
}: {
  supabase: SupabaseClient;
  request: NextRequest;
  token: string;
  settings: PinSettings;
}): Promise<PortalPinResult> {
  if (!settings.pin) return { ok: true };

  const pin = request.headers.get('x-portal-pin');
  // "No PIN yet" is the normal first load: nothing to count or log.
  if (!pin) return { ok: false, reason: 'required' };

  const now = Date.now();
  const ip = getClientIp(request);
  const { data: recent } = await supabase
    .from('portal_events')
    .select('ip_address, created_at')
    .eq('portal_settings_id', settings.id)
    .eq('event_type', 'pin_attempt')
    .gte('created_at', new Date(now - DAY_MS).toISOString())
    .order('created_at', { ascending: false })
    // Newest first, so a capped read still holds every row each rule counts.
    .limit(PIN_MAX_MISSES_PER_PORTAL_DAY);

  const misses: PinAttempt[] = (recent ?? []).map(row => ({
    ip: row.ip_address ? stripCidrHostPrefix(String(row.ip_address)) : null,
    at: Date.parse(row.created_at),
  }));
  // Checked before the comparison, so a locked visitor learns nothing even
  // when the guess is right.
  const retryAfterSeconds = pinLockoutSeconds(misses, ip, now);
  if (retryAfterSeconds > 0) return { ok: false, reason: 'locked', retryAfterSeconds };

  if (pinsMatch(pin, settings.pin)) return { ok: true };

  await recordPortalEvent({
    supabase,
    request,
    token,
    portalSettingsId: settings.id,
    projectId: settings.project_id,
    sessionId: getOrCreateSessionId(request),
    eventType: 'pin_attempt',
    metadata: { success: false },
  });
  return { ok: false, reason: 'invalid' };
}

/** Client-facing copy for a lockout, rounded up to whole minutes. */
export function pinLockoutMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * The response for a failed check: 401 for a missing or wrong PIN, 429 with
 * Retry-After for a lockout. `extra` carries route-specific fields such as the
 * PIN screen branding.
 */
export function pinFailureResponse(
  result: Exclude<PortalPinResult, { ok: true }>,
  extra: Record<string, unknown> = {},
): NextResponse {
  if (result.reason === 'locked') {
    return NextResponse.json(
      {
        error: pinLockoutMessage(result.retryAfterSeconds),
        pin_required: true,
        locked: true,
        retry_after_seconds: result.retryAfterSeconds,
        ...extra,
      },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
    );
  }
  return NextResponse.json(
    {
      error: result.reason === 'invalid' ? 'Invalid PIN' : 'PIN required',
      pin_required: true,
      ...extra,
    },
    { status: 401 },
  );
}
