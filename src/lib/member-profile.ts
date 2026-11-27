/**
 * A person's profile fields, the rules the browser and the server share:
 * a display name is required and trimmed, and a time zone is a real IANA
 * zone. Pure, so Settings, the workspace route, the v1 API and the tests
 * read the same answer.
 */

export const MEMBER_NAME_MAX = 100;

/** The name as it is saved (trimmed, inner runs of spaces kept as one), or the plain reason it cannot be. */
export function checkMemberName(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'Enter a name.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'Enter a name. It is how everyone sees you.' };
  if (name.length > MEMBER_NAME_MAX) return { ok: false, error: `Keep the name to ${MEMBER_NAME_MAX} characters.` };
  return { ok: true, name };
}

/** Whether the runtime knows this IANA time zone ("America/Phoenix", "UTC"). */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim() || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
