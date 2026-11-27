import type { NextRequest } from 'next/server';

/**
 * Cross-site writes. A signed-in session rides on cookies, and SameSite=Lax
 * still lets a page on a sibling subdomain post to the app with them, so a
 * write to /api that carries the session cookie and names another site in
 * its Origin is refused (deep security review of 2.0.50, finding 7). The
 * proxy applies it to every such request (src/proxy.ts).
 *
 * A request without the session cookie has no session to borrow, so
 * webhooks, crons, internal jobs, chat and email providers and portal
 * visitors are never affected. The key-based routes that answer any origin
 * on purpose (the API, MCP, the Connect AI token endpoints) are left to their
 * own auth even when a browser happens to send the cookie.
 */

/** Browsers always send Origin on a write; one naming another site is refused. */
export function foreignOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') === 'cross-site';
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    // "null" (a sandboxed frame or a file) is no site of ours.
    return true;
  }
  const hosts = [request.nextUrl.host, request.headers.get('host'), request.headers.get('x-forwarded-host')];
  return !hosts.includes(host);
}

/** Routes that answer any origin by design and never act on the session cookie. */
export const ORIGIN_CHECK_EXEMPT = ['/api/v1/', '/api/mcp', '/api/oauth/token', '/api/oauth/register'] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether the request carries a Supabase session cookie (sb-<project>-auth-token, possibly in chunks). */
export function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name));
}

/** Whether the proxy checks this request's Origin: a write to /api with the session on it. */
export function needsOriginCheck(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const path = request.nextUrl.pathname;
  if (!path.startsWith('/api/')) return false;
  if (ORIGIN_CHECK_EXEMPT.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)))) return false;
  return hasSessionCookie(request);
}
