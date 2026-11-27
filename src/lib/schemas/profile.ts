import { z } from 'zod';
import { isSafeAvatarUrl } from '@/lib/security/safe-url';

/**
 * One place for the checks on what a person or agent profile stores: every
 * route and MCP tool that sets an avatar, a timezone or notification
 * preferences uses these, so a value the app cannot render safely, or that
 * breaks a teammate's screen, is refused (422) wherever it comes from.
 */

/** The Supabase project URL, so links into its storage must be public avatar files. */
function supabaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? null;
}

/** Whether `value` may be stored as an avatar: empty (no picture) or a safe picture link. */
export function isStorableAvatar(value: string): boolean {
  return value.trim() === '' || isSafeAvatarUrl(value, { supabaseUrl: supabaseUrl() });
}

const AVATAR_MESSAGE = 'An avatar must be an https picture link or a path on this app';

/** An avatar link: https (http only on a local host), a path on this app, or empty to clear it. */
export const avatarUrlSchema = z.string().max(2000).refine(isStorableAvatar, AVATAR_MESSAGE);

/**
 * Whether the runtime knows this IANA time zone. Read the way the app reads
 * it (Intl.DateTimeFormat), so a stored zone can never throw a RangeError on
 * a teammate's screen.
 */
export function isKnownTimeZone(value: string): boolean {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().refine(isKnownTimeZone, 'timezone must be an IANA time zone such as America/Phoenix');

/** Notification preferences: a plain object of category keys to on or off. */
export const notificationPrefsSchema = z.record(z.string().max(100), z.boolean());

/**
 * The profile fields of an update, checked: the first problem as a message,
 * or null when every field present is valid. Fields left out are not checked.
 */
export function profileFieldProblem(updates: Record<string, unknown>): string | null {
  if ('avatar' in updates) {
    const avatar = updates.avatar;
    if (avatar !== null && (typeof avatar !== 'string' || !avatarUrlSchema.safeParse(avatar).success)) return AVATAR_MESSAGE;
  }
  if ('timezone' in updates && (typeof updates.timezone !== 'string' || !isKnownTimeZone(updates.timezone))) {
    return 'timezone must be an IANA time zone such as America/Phoenix';
  }
  for (const field of ['notification_prefs', 'email_notification_prefs'] as const) {
    if (field in updates && !notificationPrefsSchema.safeParse(updates[field]).success) {
      return `${field} must be an object of category keys to true or false`;
    }
  }
  if ('name' in updates && (typeof updates.name !== 'string' || !updates.name.trim() || updates.name.length > 200)) {
    return 'name must be 1 to 200 characters';
  }
  return null;
}
