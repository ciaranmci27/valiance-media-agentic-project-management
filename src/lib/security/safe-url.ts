/**
 * One place that decides which links from stored data the app will put in
 * an `src` or `href`. Text in the database can come from any member, an
 * agent's key or an inbound email, so a URL is never trusted as is: a
 * `javascript:`, `data:` or `vbscript:` link, or a protocol-relative
 * `//other-host` one, is refused. Used when rendering (Avatar, links) and by
 * the server when an avatar is saved.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Control characters and whitespace, which browsers strip before reading a scheme. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** A path on this app: one leading slash, never `//host` or `/\host`. */
export function isRelativeAppPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && !hasControl(value);
}

function parseAbsolute(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}

/** An absolute http(s) link: https anywhere, http only on a local host unless `allowHttp`. */
function isWebUrl(value: string, allowHttp: boolean): boolean {
  if (hasControl(value)) return false;
  const url = parseAbsolute(value);
  if (!url) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (allowHttp || isLocalHost(url));
}

export interface AvatarUrlOptions {
  /**
   * The Supabase project URL (NEXT_PUBLIC_SUPABASE_URL). When given, a link
   * into its storage must point at the `pm-avatars` bucket's public files.
   */
  supabaseUrl?: string | null;
}

/**
 * Whether a link may be saved as someone's avatar: an https picture, an http
 * one on a local host (a local stack's storage), or a path on this app.
 * Links into this project's Supabase storage must be public `pm-avatars`
 * files, so an avatar can never point at a private file's signed link.
 */
export function isSafeAvatarUrl(url: string, opts: AvatarUrlOptions = {}): boolean {
  if (typeof url !== 'string') return false;
  const value = url.trim();
  if (!value || value.length > 2000) return false;
  if (isRelativeAppPath(value)) return true;
  if (!isWebUrl(value, false)) return false;
  const supabase = opts.supabaseUrl ? parseAbsolute(opts.supabaseUrl.trim()) : null;
  if (supabase) {
    const parsed = new URL(value);
    if (parsed.origin === supabase.origin && parsed.pathname.startsWith('/storage/')) {
      return parsed.pathname.startsWith('/storage/v1/object/public/pm-avatars/')
        || parsed.pathname.startsWith('/storage/v1/object/public/avatars/');
    }
  }
  return true;
}

/**
 * A picture link safe to render in an `<img src>`: http(s), a path on this
 * app, or a `blob:` preview made in this page. Anything else gives null, and
 * the caller shows its fallback (initials).
 */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value) return null;
  if (isRelativeAppPath(value)) return value;
  if (isWebUrl(value, true)) return value;
  if (value.startsWith('blob:') && !hasControl(value)) {
    const inner = parseAbsolute(value.slice(5));
    if (inner && (inner.protocol === 'https:' || inner.protocol === 'http:')) return value;
  }
  return null;
}

/**
 * A link safe for an `<a href>`: http(s), mailto:, tel: or a path on this
 * app. Anything else gives null, and the caller renders plain text.
 */
export function safeLinkHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value) return null;
  if (isRelativeAppPath(value)) return value;
  if (isWebUrl(value, true)) return value;
  if (/^(mailto|tel):/i.test(value) && !hasControl(value)) return value;
  return null;
}
