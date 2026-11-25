import { safeNextPath } from '@/lib/supabase/next-path';

/**
 * What a Google round trip is for, kept in a short-lived cookie the server
 * sets before the browser leaves for Google (POST /api/auth/google) and the
 * callback reads once. So Google always returns to one exact address,
 * /auth/callback, with nothing in it but Supabase's code, and that address
 * is the only one to allow in Supabase.
 *
 * The cookie is httpOnly, so page scripts never read it. The browser could
 * still send a made-up one, so the callback trusts nothing in it on its own:
 * a sign-in still passes the roster gate, an invite token is checked again,
 * and the first-owner claim checks the setup code again.
 */

export const GOOGLE_INTENT_COOKIE = 'pm-google-intent';
/** Long enough to pick an account at Google, short enough not to linger. */
export const GOOGLE_INTENT_MAX_AGE = 15 * 60;

export type GoogleIntent =
  | { kind: 'sign-in'; next: string | null }
  | { kind: 'link' }
  | { kind: 'invite'; token: string }
  | { kind: 'first-owner'; name: string; setupCode: string; startedAt: number };

export function encodeGoogleIntent(intent: GoogleIntent): string {
  return Buffer.from(JSON.stringify(intent)).toString('base64url');
}

/** The intent in a cookie value, or a plain sign-in when it is missing or not one we wrote. */
export function decodeGoogleIntent(value: string | null | undefined): GoogleIntent {
  const fallback: GoogleIntent = { kind: 'sign-in', next: null };
  if (!value || value.length > 4096) return fallback;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== 'object') return fallback;
  const text = (key: string, max: number) => (typeof raw[key] === 'string' && (raw[key] as string).length <= max ? (raw[key] as string) : null);
  switch (raw.kind) {
    case 'sign-in':
      return { kind: 'sign-in', next: safeNextPath(text('next', 2048)) };
    case 'link':
      return { kind: 'link' };
    case 'invite': {
      const token = text('token', 100);
      return token ? { kind: 'invite', token } : fallback;
    }
    case 'first-owner': {
      const name = text('name', 100);
      const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : NaN;
      return name !== null ? { kind: 'first-owner', name, setupCode: text('setupCode', 512) ?? '', startedAt } : fallback;
    }
    default:
      return fallback;
  }
}

/** Cookie options: httpOnly, same-site lax (it must ride the return from Google), secure over https. */
export function googleIntentCookieOptions(secure: boolean, maxAge = GOOGLE_INTENT_MAX_AGE) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge };
}
