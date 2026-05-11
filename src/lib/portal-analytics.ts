/**
 * Server-side helpers for the portal analytics pipeline.
 *
 * Stays internal-only: no external geo lookups, no third-party UA parsing
 * libraries. Everything runs from the request headers and a small regex-based
 * UA classifier. Failure to write an event is swallowed so analytics can
 * never break the surrounding portal request.
 */
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PortalEventClientContext, PortalEventType } from '@/lib/types';

/** Pull the originating client IP out of the request headers. Trusts the
 *  first hop in x-forwarded-for, falling back through the usual proxy
 *  headers. Returns null if nothing usable is present. */
export function getClientIp(request: NextRequest): string | null {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  return null;
}

/** Hash an IP into an opaque token. Includes UA + token so the same IP behind
 *  a NAT looks distinct per browser, which is what "unique visitor" usually
 *  means in this context. Truncated to 16 hex chars (64 bits) so the value
 *  is comfortable to render in tables. */
export function hashClientIdentity(
  ip: string | null,
  userAgent: string | null,
  token: string,
): string | null {
  if (!ip) return null;
  return createHash('sha256')
    .update(`${ip}|${userAgent ?? ''}|${token}`)
    .digest('hex')
    .slice(0, 16);
}

interface ParsedUserAgent {
  device_type: 'mobile' | 'tablet' | 'desktop' | null;
  browser: string | null;
  os: string | null;
}

/** Regex-based UA classifier. Not exhaustive, but covers every browser /
 *  device combination that actually shows up in client portals. Everything
 *  unknown falls back to null so the dashboard can show "Unknown" rather
 *  than wrong data. */
export function parseUserAgent(ua: string | null): ParsedUserAgent {
  if (!ua) return { device_type: null, browser: null, os: null };

  const isTablet = /iPad|Tablet|PlayBook|(?:Android(?!.*Mobile))/i.test(ua);
  const isMobile = !isTablet && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua);
  const device_type: ParsedUserAgent['device_type'] = isTablet
    ? 'tablet'
    : isMobile
      ? 'mobile'
      : 'desktop';

  let os: string | null = null;
  let osMatch: RegExpMatchArray | null;
  if ((osMatch = ua.match(/Windows NT ([\d.]+)/))) {
    const map: Record<string, string> = {
      '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7',
    };
    os = `Windows ${map[osMatch[1]] ?? osMatch[1]}`;
  } else if ((osMatch = ua.match(/Mac OS X ([\d_.]+)/))) {
    os = `macOS ${osMatch[1].replace(/_/g, '.')}`;
  } else if ((osMatch = ua.match(/iPhone OS ([\d_]+)/)) || (osMatch = ua.match(/CPU OS ([\d_]+)/))) {
    os = `iOS ${osMatch[1].replace(/_/g, '.')}`;
  } else if ((osMatch = ua.match(/Android ([\d.]+)/))) {
    os = `Android ${osMatch[1]}`;
  } else if (/CrOS/.test(ua)) {
    os = 'ChromeOS';
  } else if (/Linux/.test(ua)) {
    os = 'Linux';
  }

  let browser: string | null = null;
  let brMatch: RegExpMatchArray | null;
  // Order matters: Edge contains "Chrome", Chrome contains "Safari".
  if ((brMatch = ua.match(/Edg\/([\d.]+)/))) {
    browser = `Edge ${brMatch[1].split('.')[0]}`;
  } else if ((brMatch = ua.match(/OPR\/([\d.]+)/)) || (brMatch = ua.match(/Opera\/([\d.]+)/))) {
    browser = `Opera ${brMatch[1].split('.')[0]}`;
  } else if ((brMatch = ua.match(/Firefox\/([\d.]+)/))) {
    browser = `Firefox ${brMatch[1].split('.')[0]}`;
  } else if ((brMatch = ua.match(/Chrome\/([\d.]+)/))) {
    browser = `Chrome ${brMatch[1].split('.')[0]}`;
  } else if ((brMatch = ua.match(/Version\/([\d.]+).*Safari/))) {
    browser = `Safari ${brMatch[1].split('.')[0]}`;
  } else if (/Safari\//.test(ua)) {
    browser = 'Safari';
  }

  return { device_type, browser, os };
}

/** Strip out anything that isn't expected from the client context payload.
 *  The portal page sends these as a hint; we never authorize on them, but
 *  we don't want odd shapes hitting the DB either. */
export function sanitizeClientContext(
  raw: unknown,
): Required<PortalEventClientContext> {
  const empty: Required<PortalEventClientContext> = {
    timezone: null,
    language: null,
    screen_width: null,
    screen_height: null,
    viewport_width: null,
    viewport_height: null,
    connection_type: null,
    color_scheme: null,
    reduced_motion: null,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;

  const str = (v: unknown, max = 80): string | null =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
  const int = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < 0 || n > 100000) return null;
    return n;
  };

  return {
    timezone: str(r.timezone),
    language: str(r.language, 20),
    screen_width: int(r.screen_width),
    screen_height: int(r.screen_height),
    viewport_width: int(r.viewport_width),
    viewport_height: int(r.viewport_height),
    connection_type: str(r.connection_type, 20),
    color_scheme:
      r.color_scheme === 'light' || r.color_scheme === 'dark' ? r.color_scheme : null,
    reduced_motion: typeof r.reduced_motion === 'boolean' ? r.reduced_motion : null,
  };
}

export interface RecordPortalEventArgs {
  supabase: SupabaseClient;
  request: NextRequest;
  token: string;
  portalSettingsId: string;
  projectId: string;
  sessionId: string;
  eventType: PortalEventType;
  metadata?: Record<string, unknown>;
  clientContext?: PortalEventClientContext;
}

/** Insert one event row. Identity columns are derived from the request so the
 *  caller can't spoof IP / UA from the body. Errors are logged but swallowed
 *  so analytics never breaks the surrounding portal request. */
export async function recordPortalEvent(args: RecordPortalEventArgs): Promise<void> {
  const {
    supabase, request, token, portalSettingsId, projectId,
    sessionId, eventType, metadata = {}, clientContext,
  } = args;

  try {
    const ip = getClientIp(request);
    const ua = request.headers.get('user-agent');
    const referrer = request.headers.get('referer');
    const acceptLanguage = request.headers.get('accept-language');
    const parsed = parseUserAgent(ua);
    const ipHash = hashClientIdentity(ip, ua, token);
    const ctx = sanitizeClientContext(clientContext);

    const { error } = await supabase.from('portal_events').insert({
      portal_settings_id: portalSettingsId,
      project_id: projectId,
      session_id: sessionId,
      event_type: eventType,
      ip_address: ip,
      ip_hash: ipHash,
      user_agent: ua?.slice(0, 500) ?? null,
      referrer: referrer?.slice(0, 500) ?? null,
      device_type: parsed.device_type,
      browser: parsed.browser,
      os: parsed.os,
      accept_language: acceptLanguage?.slice(0, 200) ?? null,
      timezone: ctx.timezone,
      language: ctx.language,
      screen_width: ctx.screen_width,
      screen_height: ctx.screen_height,
      viewport_width: ctx.viewport_width,
      viewport_height: ctx.viewport_height,
      connection_type: ctx.connection_type,
      color_scheme: ctx.color_scheme,
      reduced_motion: ctx.reduced_motion,
      metadata,
    });
    if (error) console.error('[portal-analytics] insert failed', error);
  } catch (err) {
    console.error('[portal-analytics] unexpected error', err);
  }
}

/** UUID v4 validator. Used to reject bad session ids from the client before
 *  they hit the DB (where session_id is uuid-typed and would error). */
export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Read the session id from the request header, or generate a fresh one when
 *  the client didn't send one (e.g. a failed PIN attempt before the portal
 *  page has had a chance to write its session id to sessionStorage). */
export function getOrCreateSessionId(request: NextRequest): string {
  const headerId = request.headers.get('x-portal-session-id');
  if (isValidUuid(headerId)) return headerId;
  return crypto.randomUUID();
}

/** Strip the trivial /32 (IPv4 host) or /128 (IPv6 host) CIDR prefix that
 *  PostgreSQL's inet type appends when it returns a single-host address. */
export function stripCidrHostPrefix(ip: string): string {
  return ip.replace(/\/(?:32|128)$/, '');
}

/** Detect loopback, RFC1918 private ranges, link-local, and IPv6 unique-local
 *  addresses. Used by the portal analytics dashboard to filter out internal
 *  traffic from the "real client engagement" view. */
export function isLocalIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const bare = stripCidrHostPrefix(ip).toLowerCase();
  // IPv6 loopback + link-local + unique-local + IPv4-mapped loopback.
  if (bare === '::1' || bare === '::') return true;
  if (bare.startsWith('fe8') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) return true; // fe80::/10
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true; // fc00::/7
  if (bare.startsWith('::ffff:127.') || bare.startsWith('::ffff:10.') || bare.startsWith('::ffff:192.168.')) return true;
  // IPv4 loopback + RFC1918 + link-local.
  if (bare.startsWith('127.')) return true;
  if (bare.startsWith('10.')) return true;
  if (bare.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(bare)) return true;
  if (bare.startsWith('169.254.')) return true;
  return false;
}
