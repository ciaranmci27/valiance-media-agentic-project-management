/**
 * The one PIN check every portal route runs. A 4-digit PIN is only 10,000
 * guesses, so wrong attempts are rate limited.
 *
 * Two layers. A visitor (IP) who misses too often is locked out for a while,
 * which is the friendly limit a client mistyping will ever meet. The portal
 * itself also has hourly and daily ceilings that lock everyone out, because
 * the client IP comes from a forwarding header that some hosts let the caller
 * write: rotating it must not buy an attacker unlimited guesses. At the daily
 * ceiling a 4-digit PIN takes weeks to brute force, and every miss is visible
 * in the portal's analytics.
 *
 * The check is one database function (pm.check_portal_pin,
 * 20261127002400_security_fixes.sql): it locks the portal's row, applies the
 * limits, compares and records the miss in one transaction, so parallel
 * guesses never all read "under the limit". An address that is not one is
 * stored as no address and still counted. When the limiter cannot answer,
 * the visitor is locked (fail closed), never let through.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getClientIp, getOrCreateSessionId, recordPortalEvent } from '@/lib/portal-analytics';

/** Misses one visitor (IP) may make inside the window before a lockout. */
export const PIN_MAX_MISSES_PER_VISITOR = 5;
export const PIN_VISITOR_WINDOW_MS = 15 * 60_000;
/** Misses across every visitor that lock the whole portal. */
export const PIN_MAX_MISSES_PER_PORTAL_HOUR = 20;
export const PIN_MAX_MISSES_PER_PORTAL_DAY = 100;
/** How long a visitor waits when the limiter itself cannot answer. */
export const PIN_LIMITER_DOWN_RETRY_SECONDS = 60;

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

  const locked = (seconds: number): PortalPinResult => ({ ok: false, reason: 'locked', retryAfterSeconds: Math.max(1, Math.ceil(seconds)) });
  let answer = null as { result?: string; retry_after_seconds?: number } | null;
  try {
    const { data, error } = await supabase.rpc('check_portal_pin', {
      p_portal_settings_id: settings.id,
      p_pin: pin.slice(0, 64),
      p_ip: getClientIp(request),
    });
    if (error) throw error;
    answer = data as typeof answer;
  } catch (error) {
    console.error('[portal-pin] the limiter did not answer; locking', error);
    return locked(PIN_LIMITER_DOWN_RETRY_SECONDS);
  }

  switch (answer?.result) {
    case 'ok':
      return { ok: true };
    case 'required':
      return { ok: false, reason: 'required' };
    case 'locked':
      return locked(Number(answer.retry_after_seconds) || PIN_LIMITER_DOWN_RETRY_SECONDS);
    case 'invalid':
      // The miss is already counted; this row is the portal's analytics only.
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
    default:
      return locked(PIN_LIMITER_DOWN_RETRY_SECONDS);
  }
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
