/** Control characters and backslashes: browsers and the URL parser drop or rewrite them, which can turn a path into another host. */
const UNSAFE = /[\u0000-\u001f\u007f\\]/;
const PROBE_ORIGIN = 'http://x';

/**
 * A same-site path to return to after login, or null. Only a plain path on
 * this origin passes: never `//host`, never a control character or a
 * backslash (the URL parser strips tabs and newlines, so `/\t/host` would
 * resolve to another origin), and never the login page itself. The path
 * must still resolve to this origin once parsed.
 */
export function safeNextPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || UNSAFE.test(value)) return null;
  try {
    if (new URL(value, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return null;
  } catch {
    return null;
  }
  if (value.startsWith('/login')) return null;
  return value;
}
